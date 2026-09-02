/**
 * B4 会话管理器 —— 整个插件的心脏。
 *
 * 持有全部活跃会话：状态机、环形缓冲、输出分发、广播、独占发送。
 * 三个门（指令通道 / 数据流通道 / AI 工具）都只通过它；它是唯一接触传输层的地方。
 * 「看」（订阅）与「连」（会话）分离：订阅随管道生灭，会话只在显式断开/掉线/卸载时终结。
 * @module dsh-terminal-manager/session-manager
 */

import { randomUUID } from 'node:crypto'
import { checkCommand, type GuardOptions } from './command-guard.ts'
import type { ConnectionStore } from './connection-store.ts'
import { createEventBus } from './event-bus.ts'
import { connectSsh } from './transport/ssh.ts'
import { connectTelnet } from './transport/telnet.ts'
import type { Transport, TransportCallbacks } from './transport/types.ts'
import type { TmEventBus, TmInputSource } from './types/events.ts'
import type {
  BroadcastEntry,
  ConnectTarget,
  SendOptions,
  SendResult,
  SessionErrorCode,
  SessionManagerApi,
  SessionSnapshot,
  SessionStatus,
} from './types/session-api.ts'
import { WaitPolicy, type WaitPolicyConfig, type WaitReason } from './wait-policy.ts'

// 数据类型的正式定义在契约文件 src/types/session-api.ts；这里 re-export 保持老 import 路径可用
export type {
  BroadcastEntry,
  ConnectTarget,
  SendOptions,
  SendResult,
  SessionErrorCode,
  SessionSnapshot,
  SessionStatus,
} from './types/session-api.ts'

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 传输层工厂（可注入假实现用于测试）。 */
export type TransportFactory = (
  target: ConnectTarget,
  callbacks: TransportCallbacks,
) => Promise<Transport>

const defaultTransportFactory: TransportFactory = (target, callbacks) => {
  return target.protocol === 'ssh'
    ? connectSsh(target, callbacks)
    : connectTelnet(target, callbacks)
}

/** 每会话输出环形缓冲上限（1MB）。 */
const BUFFER_CAP_BYTES = 1024 * 1024
/** 完成判定轮询间隔。 */
const POLL_INTERVAL_MS = 50

interface SessionRecord {
  sessionId: string
  connId?: string
  label: string
  target: string
  protocol: 'ssh' | 'telnet'
  status: SessionStatus
  openedAtMs?: number
  transport?: Transport
  buffer: string
  subscribers: Set<(chunk: string) => void>
  busy: boolean
  closeReason?: string
  /** 连接级换行（来自 ConnectTarget / 连接配置），sendAndWait/sendImmediate 缺省时回退到此值 */
  newline?: 'lf' | 'cr' | 'crlf'
}

/** 输入来源缺省规则：传了 guard 就是 AI 路径，否则是人。 */
function sourceOf(options: { guard?: GuardOptions; source?: TmInputSource }, fallback: TmInputSource = 'human'): TmInputSource {
  return options.source ?? (options.guard !== undefined ? 'ai' : fallback)
}

/** 会话池。 */
export class SessionManager implements SessionManagerApi {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly statusListeners = new Set<(snapshot: SessionSnapshot) => void>()

  constructor(
    private readonly store: ConnectionStore | undefined,
    private readonly transportFactory: TransportFactory = defaultTransportFactory,
    /** 事件总线（契约 src/types/events.ts）；缺省自建一条，也可从外部注入共享 */
    readonly events: TmEventBus = createEventBus(),
  ) {}

  /** 订阅会话状态变化（连接中/已连接/已关闭）。返回取消函数。 */
  onStatus(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map(r => this.snapshot(r))
  }

  get(sessionId: string): SessionSnapshot | undefined {
    const record = this.sessions.get(sessionId)
    return record === undefined ? undefined : this.snapshot(record)
  }

  /** 按 host+port 查找已保存的连接配置（用于 AI 工具匹配已有配置）。 */
  findConnectionByTarget(protocol: 'ssh' | 'telnet', host: string, port?: number): { connId: string; label: string } | undefined {
    if (this.store === undefined) return undefined
    const defaultPort = protocol === 'ssh' ? 22 : 23
    const targetPort = port ?? defaultPort
    for (const conn of this.store.list()) {
      if (conn.protocol === protocol && conn.host === host && conn.port === targetPort) {
        return { connId: conn.id, label: conn.label }
      }
    }
    return undefined
  }

  /** 用已保存的连接建立会话；同一连接重复调用返回既有会话。 */
  async connectByConnId(connId: string): Promise<SessionSnapshot> {
    if (this.store === undefined) throw new SessionError('SESSION_NOT_FOUND', '未配置连接存储')
    await this.store.ensureLoaded()
    const conn = this.store.get(connId)
    if (conn === undefined) throw new SessionError('SESSION_NOT_FOUND', `连接不存在: ${connId}`)
    for (const record of this.sessions.values()) {
      if (record.connId === connId && record.status !== 'closed') return this.snapshot(record)
    }
    const auth = conn.auth
    return this.connect({
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      label: conn.label,
      ...(auth?.kind === 'password' ? { password: auth.password } : {}),
      ...(auth?.kind === 'key' ? { privateKey: auth.privateKey, passphrase: auth.passphrase } : {}),
      ...(conn.telnetMode !== undefined ? { telnetMode: conn.telnetMode } : {}),
      ...(conn.handshakeTimeoutSec !== undefined ? { connectTimeoutMs: conn.handshakeTimeoutSec * 1000 } : {}),
      ...(conn.newline !== undefined ? { newline: conn.newline } : {}),
      ...(conn.localEcho !== undefined ? { localEcho: conn.localEcho } : {}),
    }, connId)
  }

  /** 建立会话。同 protocol+host:port 的 open 会话直接复用（去重）。
   *  无 connId 时自动创建连接配置入库（出现在「最近连接」）。 */
  async connect(target: ConnectTarget, connId?: string): Promise<SessionSnapshot> {
    // 去重：同协议+同地址的 open 会话直接返回
    const targetKey = `${target.protocol}:${target.host}:${target.port}`
    for (const record of this.sessions.values()) {
      if (record.status === 'open' && `${record.protocol}:${record.target}` === targetKey) {
        return this.snapshot(record)
      }
    }
    // 无 connId 时自动创建连接配置（临时连接也入「最近连接」）
    let effectiveConnId = connId
    if (effectiveConnId === undefined && this.store !== undefined) {
      await this.store.ensureLoaded()
      // 将 ConnectTarget 的扁平凭据字段转换为 ConnectionConfig 的 auth 嵌套格式
      const auth = target.password !== undefined
        ? { kind: 'password' as const, password: target.password }
        : target.privateKey !== undefined
          ? { kind: 'key' as const, privateKey: target.privateKey, ...(target.passphrase !== undefined ? { passphrase: target.passphrase } : {}) }
          : undefined
      const autoConn = await this.store.create({
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        label: target.label ?? target.host,
        favorited: false, // 临时连接（含 AI 工具创建的）入「最近连接」而非「收藏」
        ...(target.username !== undefined ? { username: target.username } : {}),
        ...(auth !== undefined ? { auth } : {}),
      })
      effectiveConnId = autoConn.id
    }
    const sessionId = randomUUID()
    const record: SessionRecord = {
      sessionId,
      connId: effectiveConnId,
      label: target.label ?? target.host,
      target: `${target.host}:${target.port}`,
      protocol: target.protocol,
      status: 'connecting',
      buffer: '',
      subscribers: new Set(),
      busy: false,
      ...(target.newline !== undefined ? { newline: target.newline } : {}),
    }
    this.sessions.set(sessionId, record)
    this.notify(record)
    try {
      const transport = await this.transportFactory(target, {
        onData: (chunk) => this.handleData(record, chunk),
        onClose: (reason) => this.handleClose(record, reason),
      })
      record.transport = transport
      record.status = 'open'
      record.openedAtMs = Date.now()
      this.notify(record)
      return this.snapshot(record)
    } catch (error) {
      this.sessions.delete(sessionId)
      // 连接失败时不通知前端，会话已删除，不应出现在列表中
      throw error
    }
  }

  /** 主动断开会话（用户操作）。标记为 removed 并从列表中删除。 */
  async disconnect(sessionId: string): Promise<void> {
    const record = this.requireRecord(sessionId)
    if (record.status === 'removed') return
    // 无论 open 还是 closed，都标记为 removed 并删除
    record.status = 'removed'
    this.sessions.delete(record.sessionId)
    if (record.transport !== undefined) {
      try { await record.transport.close() } catch { /* ignore */ }
      record.transport = undefined
    }
    this.notify(record)
  }

  /** 重连已断开的会话（被动断开后恢复）。 */
  async reconnect(sessionId: string): Promise<SessionSnapshot> {
    const record = this.requireRecord(sessionId)
    if (record.status !== 'closed') {
      throw new SessionError('SESSION_NOT_DISCONNECTED', '会话未处于断开状态')
    }
    // 清理旧 transport（如果有）
    if (record.transport !== undefined) {
      try { await record.transport.close() } catch { /* ignore */ }
      record.transport = undefined
    }
    // 重新建立连接
    record.status = 'connecting'
    record.closeReason = undefined
    this.notify(record)
    try {
      const conn = record.connId !== undefined && this.store !== undefined
        ? this.store.get(record.connId)
        : undefined
      if (conn === undefined) {
        throw new SessionError('SESSION_NOT_FOUND', '无法获取连接配置')
      }
      const auth = conn.auth
      const transport = await this.transportFactory({
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        ...(auth?.kind === 'password' ? { password: auth.password } : {}),
        ...(auth?.kind === 'key' ? { privateKey: auth.privateKey, passphrase: auth.passphrase } : {}),
        ...(conn.telnetMode !== undefined ? { telnetMode: conn.telnetMode } : {}),
        ...(conn.handshakeTimeoutSec !== undefined ? { connectTimeoutMs: conn.handshakeTimeoutSec * 1000 } : {}),
      }, {
        onData: (chunk) => this.handleData(record, chunk),
        onClose: (reason) => this.handleClose(record, reason),
      })
      record.transport = transport
      record.status = 'open'
      record.openedAtMs = Date.now()
      this.notify(record)
      return this.snapshot(record)
    } catch (error) {
      record.status = 'closed'
      this.notify(record)
      throw error
    }
  }

  /** 订阅一个会话的输出（"看"）。返回取消订阅函数。 */
  subscribe(sessionId: string, listener: (chunk: string) => void): () => void {
    const record = this.requireRecord(sessionId)
    record.subscribers.add(listener)
    return () => { record.subscribers.delete(listener) }
  }

  /** 人工键入：原样写入，不排队、不过守卫。 */
  write(sessionId: string, data: string): void {
    const record = this.requireOpen(sessionId)
    record.transport?.write(data)
    this.events.emit({ type: 'input', sessionId, data, source: 'human', ts: Date.now() })
  }

  /** AI 路径"发完即回"：过守卫，追加换行写入，不等待执行完成。换行优先用调用参数，其次连接级配置，缺省 crlf。 */
  async sendImmediate(sessionId: string, command: string, options: Pick<SendOptions, 'guard' | 'signal' | 'newline' | 'source'> = {}): Promise<void> {
    const record = this.requireOpen(sessionId)
    if (record.busy) throw new SessionError('SESSION_BUSY', '该会话正在执行另一条发送')
    this.assertAllowed(record, command, options)
    record.transport?.write(command + this.eolOf(record, options.newline))
    this.events.emit({ type: 'input', sessionId, data: command, source: sourceOf(options), ts: Date.now() })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const record = this.requireOpen(sessionId)
    record.transport?.resize?.(cols, rows)
  }

  /** 读当前缓冲（回看）。 */
  read(sessionId: string, count = 500): { text: string; totalLines: number; truncated: boolean } {
    const record = this.requireRecord(sessionId)
    const lines = record.buffer.split('\n')
    const totalLines = lines.length
    const taken = lines.slice(-count)
    return { text: taken.join('\n'), totalLines, truncated: totalLines > count }
  }

  /**
   * 发送命令并等待执行完成（AI 路径）。独占：同会话同时只跑一条。
   * guard 传入时做命令守卫检查（命中抛 COMMAND_BLOCKED）。
   */
  async sendAndWait(sessionId: string, command: string, options: SendOptions = {}): Promise<SendResult> {
    const record = this.requireOpen(sessionId)
    if (record.busy) throw new SessionError('SESSION_BUSY', '该会话正在执行另一条发送')
    this.assertAllowed(record, command, options)
    if (options.signal?.aborted) throw new SessionError('DISCONNECTED', '发送已被取消')
    record.busy = true
    try {
      const waitConfig = this.resolveWaitConfig(record, options.wait)
      const policy = new WaitPolicy(waitConfig)
      const submit = options.submit ?? true
      const eol = this.eolOf(record, options.newline)

      const outcome = await new Promise<WaitReason>((resolve, reject) => {
        policy.start(Date.now())
        let done = false
        const finish = (reason: WaitReason): void => {
          if (done) return
          done = true
          clearInterval(timer)
          unsubscribe()
          resolve(reason)
        }
        const fail = (error: unknown): void => {
          if (done) return
          done = true
          clearInterval(timer)
          unsubscribe()
          reject(error)
        }
        const unsubscribe = this.subscribe(sessionId, (chunk) => {
          const reason = policy.feed(chunk, Date.now())
          if (reason !== undefined) finish(reason)
        })
        const timer = setInterval(() => {
          if (options.signal?.aborted) {
            fail(new SessionError('DISCONNECTED', '发送已被取消'))
            return
          }
          if (record.status !== 'open') {
            fail(new SessionError('DISCONNECTED', '等待期间会话已断开'))
            return
          }
          const reason = policy.poll(Date.now())
          if (reason !== undefined) finish(reason)
        }, POLL_INTERVAL_MS)
        record.transport?.write(command + (submit ? eol : ''))
        this.events.emit({ type: 'input', sessionId, data: command, source: sourceOf(options), ts: Date.now() })
      })

      return { output: policy.output(), waitReason: outcome, truncated: policy.truncated() }
    } finally {
      record.busy = false
    }
  }

  /** 广播：逐台独立执行、互不阻塞，每台单独出结果。 */
  async broadcast(command: string, targetSessionIds?: readonly string[], rawOptions: SendOptions = {}): Promise<BroadcastEntry[]> {
    const options: SendOptions = { ...rawOptions, source: sourceOf(rawOptions, 'broadcast') }
    const targets = targetSessionIds !== undefined
      ? targetSessionIds
      : [...this.sessions.values()].filter(r => r.status === 'open').map(r => r.sessionId)
    const entries = await Promise.all(targets.map(async (sessionId): Promise<BroadcastEntry> => {
      const record = this.sessions.get(sessionId)
      if (record === undefined || record.status !== 'open') {
        return { sessionId, outcome: 'disconnected', code: 'DISCONNECTED' }
      }
      if (record.busy) return { sessionId, outcome: 'busy', code: 'SESSION_BUSY' }
      try {
        const result = await this.sendAndWait(sessionId, command, options)
        return { sessionId, outcome: 'ok', result }
      } catch (error) {
        const code = error instanceof SessionError ? error.code : 'PROTO_ERROR'
        return { sessionId, outcome: 'error', code }
      }
    }))
    return entries
  }

  /** 关闭全部会话（插件卸载时用）。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(r => r.transport?.close()))
  }

  /** 会话对应的连接配置（完成判定覆盖参数的来源）。 */
  private connectionOf(record: SessionRecord) {
    return record.connId !== undefined ? this.store?.get(record.connId) : undefined
  }

  /** 合并守卫选项：连接级白名单 + 调用方补充规则。 */
  private mergeGuard(record: SessionRecord, guard: GuardOptions): GuardOptions {
    const conn = this.connectionOf(record)
    const whitelist = [...(conn?.guardWhitelist ?? []), ...(guard.whitelist ?? [])]
    return {
      ...(whitelist.length > 0 ? { whitelist } : {}),
      ...(guard.extraRules !== undefined ? { extraRules: guard.extraRules } : {}),
    }
  }

  /** 命令守卫检查（仅当 options.guard 传入时启用，即 AI 路径）。命中抛 COMMAND_BLOCKED。 */
  private assertAllowed(record: SessionRecord, command: string, options: { guard?: GuardOptions }): void {
    if (options.guard === undefined) return
    const decision = checkCommand(command, this.mergeGuard(record, options.guard))
    if (decision.verdict === 'block') {
      throw new SessionError('COMMAND_BLOCKED', `命令被安全策略拦截：${decision.rule?.why ?? '未知原因'}`)
    }
  }

  private resolveWaitConfig(record: SessionRecord, overrides?: WaitPolicyConfig): WaitPolicyConfig {
    const conn = this.connectionOf(record)
    return {
      ...(conn?.quietMs !== undefined ? { quietMs: conn.quietMs } : {}),
      ...(conn?.promptPattern !== undefined ? { promptPattern: conn.promptPattern } : {}),
      ...(conn?.timeoutMs !== undefined ? { timeoutMs: conn.timeoutMs } : {}),
      ...overrides,
    }
  }

  /** 行尾换行串：优先调用参数，其次连接配置的 newline（实时读 conn），再次会话建立时的记录值（临时连接），缺省 crlf（\r\n）。 */
  private eolOf(record: SessionRecord, override?: 'lf' | 'cr' | 'crlf'): string {
    const conn = this.connectionOf(record)
    const nl = override ?? conn?.newline ?? record.newline ?? 'crlf'
    return nl === 'lf' ? '\n' : nl === 'cr' ? '\r' : '\r\n'
  }

  private handleData(record: SessionRecord, chunk: string): void {
    record.buffer += chunk
    if (record.buffer.length > BUFFER_CAP_BYTES) {
      record.buffer = record.buffer.slice(record.buffer.length - BUFFER_CAP_BYTES)
    }
    for (const listener of [...record.subscribers]) listener(chunk)
    this.events.emit({ type: 'output', sessionId: record.sessionId, data: chunk, ts: Date.now() })
  }

  private handleClose(record: SessionRecord, reason: string): void {
    if (record.status === 'closed' || record.status === 'removed') return
    record.status = 'closed'
    record.closeReason = reason
    // 被动断开：保留在列表中（不删除），前端显示「已断开」状态
    this.notify(record)
  }

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${sessionId}`)
    return record
  }

  private requireOpen(sessionId: string): SessionRecord {
    const record = this.requireRecord(sessionId)
    if (record.status !== 'open') throw new SessionError('DISCONNECTED', '会话已断开')
    return record
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    return {
      sessionId: record.sessionId,
      ...(record.connId !== undefined ? { connId: record.connId } : {}),
      label: record.label,
      target: record.target,
      protocol: record.protocol,
      status: record.status,
      ...(record.openedAtMs !== undefined ? { openedAtMs: record.openedAtMs } : {}),
      ...(record.closeReason !== undefined ? { closeReason: record.closeReason } : {}),
    }
  }

  private notify(record: SessionRecord): void {
    const snap = this.snapshot(record)
    for (const listener of [...this.statusListeners]) listener(snap)
    this.events.emit({ type: 'status', sessionId: snap.sessionId, status: snap.status, snapshot: snap, ts: Date.now() })
  }
}

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
import { connectSsh } from './transport/ssh.ts'
import { connectTelnet } from './transport/telnet.ts'
import type { Transport, TransportCallbacks } from './transport/types.ts'
import { WaitPolicy, type WaitPolicyConfig, type WaitReason } from './wait-policy.ts'

export type SessionStatus = 'connecting' | 'open' | 'closed'

export interface SessionSnapshot {
  sessionId: string
  connId?: string
  label: string
  target: string
  protocol: 'ssh' | 'telnet'
  status: SessionStatus
  openedAtMs?: number
}

export interface SendResult {
  output: string
  waitReason: WaitReason
  truncated: boolean
}

export interface BroadcastEntry {
  sessionId: string
  outcome: 'ok' | 'busy' | 'disconnected' | 'error'
  result?: SendResult
  code?: string
}

export type SessionErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'DISCONNECTED' | 'COMMAND_BLOCKED'

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 连接目标的传输层参数（由存储或临时连接提供）。 */
export interface ConnectTarget {
  protocol: 'ssh' | 'telnet'
  host: string
  port: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  label?: string
  /** Telnet 模式：'telnet'（协议协商）| 'raw'（裸 TCP，默认） */
  telnetMode?: 'telnet' | 'raw'
  /** SSH 握手超时毫秒（默认 15000） */
  connectTimeoutMs?: number
  /** 换行模式（默认 'crlf'） */
  newline?: 'lf' | 'cr' | 'crlf'
  /** 本地回显（默认 false） */
  localEcho?: boolean
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
}

export interface SendOptions {
  /** 覆盖完成判定参数（缺省用连接配置，再缺省用全局默认） */
  wait?: WaitPolicyConfig
  /** 传入则做命令守卫检查（AI 路径必传，人工键入不传） */
  guard?: GuardOptions
  /** 换行模式：'lf' | 'cr' | 'crlf'（默认 'crlf'） */
  newline?: 'lf' | 'cr' | 'crlf'
  /** 本地回显（默认 false） */
  localEcho?: boolean
  /** 命令后是否追加回车，默认 true */
  submit?: boolean
  /** 取消信号（AI 工具层透传 exec.signal） */
  signal?: AbortSignal
}

/** 会话池。 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly statusListeners = new Set<(snapshot: SessionSnapshot) => void>()

  constructor(
    private readonly store: ConnectionStore | undefined,
    private readonly transportFactory: TransportFactory = defaultTransportFactory,
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

  /** 建立会话（临时连接不入库）。同 protocol+host:port 的 open 会话直接复用（去重）。 */
  async connect(target: ConnectTarget, connId?: string): Promise<SessionSnapshot> {
    // 去重：同协议+同地址的 open 会话直接返回
    const targetKey = `${target.protocol}:${target.host}:${target.port}`
    for (const record of this.sessions.values()) {
      if (record.status === 'open' && `${record.protocol}:${record.target}` === targetKey) {
        return this.snapshot(record)
      }
    }
    const sessionId = randomUUID()
    const record: SessionRecord = {
      sessionId,
      connId,
      label: target.label ?? target.host,
      target: `${target.host}:${target.port}`,
      protocol: target.protocol,
      status: 'connecting',
      buffer: '',
      subscribers: new Set(),
      busy: false,
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
      record.status = 'closed'
      this.notify(record)
      throw error
    }
  }

  /** 断开会话。 */
  async disconnect(sessionId: string): Promise<void> {
    const record = this.requireRecord(sessionId)
    await record.transport?.close()
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
  }

  /** AI 路径"发完即回"：过守卫，追加回车写入，不等待执行完成。 */
  async sendImmediate(sessionId: string, command: string, options: { guard?: GuardOptions; signal?: AbortSignal } = {}): Promise<void> {
    const record = this.requireOpen(sessionId)
    if (record.busy) throw new SessionError('SESSION_BUSY', '该会话正在执行另一条发送')
    this.assertAllowed(record, command, options)
    record.transport?.write(command + '\r')
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
      const nl = options.newline ?? 'crlf'
      const eol = nl === 'lf' ? '\n' : nl === 'cr' ? '\r' : '\r\n'

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
      })

      return { output: policy.output(), waitReason: outcome, truncated: policy.truncated() }
    } finally {
      record.busy = false
    }
  }

  /** 广播：逐台独立执行、互不阻塞，每台单独出结果。 */
  async broadcast(command: string, targetSessionIds?: readonly string[], options: SendOptions = {}): Promise<BroadcastEntry[]> {
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

  private handleData(record: SessionRecord, chunk: string): void {
    record.buffer += chunk
    if (record.buffer.length > BUFFER_CAP_BYTES) {
      record.buffer = record.buffer.slice(record.buffer.length - BUFFER_CAP_BYTES)
    }
    for (const listener of [...record.subscribers]) listener(chunk)
  }

  private handleClose(record: SessionRecord, reason: string): void {
    if (record.status === 'closed') return
    record.status = 'closed'
    this.sessions.delete(record.sessionId)
    this.notify(record, reason)
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
    }
  }

  private notify(record: SessionRecord, _reason?: string): void {
    const snap = this.snapshot(record)
    for (const listener of [...this.statusListeners]) listener(snap)
  }
}

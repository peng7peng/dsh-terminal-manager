/**
 * 模块间契约 ②：会话管理器（B4）对扩展模块承诺稳定的公开面。
 *
 * 规则：本目录（src/types/）只放声明，不放实现；任何改动单独提 PR 到 main，两人 review。
 * 扩展模块（日志管理 / 共享端口）只能用这里列出的方法；`SessionManager` 上其他方法视为主线内部实现，随时可变。
 * 数据类型（SessionSnapshot 等）也定义在这里，`session-manager.ts` 原样 re-export，老 import 路径不变。
 * @module dsh-terminal-manager/types/session-api
 */

import type { GuardOptions } from '../command-guard.ts'
import type { WaitPolicyConfig, WaitReason } from '../wait-policy.ts'
import type { TmEventBus, TmInputSource } from './events.ts'

export type SessionStatus = 'connecting' | 'open' | 'closed' | 'removed'

export interface SessionSnapshot {
  sessionId: string
  connId?: string
  label: string
  target: string
  protocol: 'ssh' | 'telnet'
  status: SessionStatus
  openedAtMs?: number
  closeReason?: string
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

export type SessionErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'DISCONNECTED' | 'COMMAND_BLOCKED' | 'SESSION_NOT_DISCONNECTED'

/** 认证配置（密码或密钥；与 ConnectionConfig.auth 同构，消除扁平/嵌套两套结构） */
export type AuthConfig =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase?: string }

/** 连接目标的传输层参数（由存储或临时连接提供）。 */
export interface ConnectTarget {
  protocol: 'ssh' | 'telnet'
  host: string
  port: number
  username?: string
  auth?: AuthConfig
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
  /** 输入来源标记（进事件总线 `input` 事件）；缺省：传了 guard = 'ai'，否则 'human' */
  source?: TmInputSource
}

/** 会话管理器公开面。 */
export interface SessionManagerApi {
  /** 事件总线（output / input / status / file） */
  readonly events: TmEventBus

  list(): SessionSnapshot[]
  get(sessionId: string): SessionSnapshot | undefined
  /** 订阅会话状态变化；返回取消函数（等价于 events.on(h, { type: 'status' })，保留给已有调用方） */
  onStatus(listener: (snapshot: SessionSnapshot) => void): () => void

  /** 建立会话（同 protocol:host:port 的 open 会话直接复用） */
  connect(target: ConnectTarget, connId?: string): Promise<SessionSnapshot>
  /** 用已保存的连接建立会话 */
  connectByConnId(connId: string): Promise<SessionSnapshot>
  /** 主动断开并从会话池移除 */
  disconnect(sessionId: string): Promise<void>
  /** 重连 closed 状态的会话 */
  reconnect(sessionId: string): Promise<SessionSnapshot>

  /** 订阅某会话的输出流；返回取消函数 */
  subscribe(sessionId: string, listener: (chunk: string) => void): () => void
  /** 读环形缓冲最近 count 行 */
  read(sessionId: string, count?: number): { text: string; totalLines: number; truncated: boolean }

  /** 人工键入：原样写入，不排队、不过守卫 */
  write(sessionId: string, data: string): void
  /** 发完即回：追加换行写入，不等完成；传 guard 则过守卫 */
  sendImmediate(sessionId: string, command: string, options?: Pick<SendOptions, 'guard' | 'signal' | 'newline' | 'source'>): Promise<void>
  /** 发送并等完成判定（静默 / 提示符 / 超时）；同会话独占 */
  sendAndWait(sessionId: string, command: string, options?: SendOptions): Promise<SendResult>
  /** 广播：逐台独立执行，每台单独出结果 */
  broadcast(command: string, targetSessionIds?: readonly string[], options?: SendOptions): Promise<BroadcastEntry[]>
}

/**
 * F5 WS 客户端 —— 与 /term-io 数据流通道的单条多路复用连接。
 *
 * 维持一条 WebSocket，按会话分发帧；断线自动重连（重连后重新附着所有可见会话）。
 * 纯 TS，不依赖 React，便于测试（注入 ws-like 构造器）。
 * @module dsh-terminal-manager/client/ws
 */

export type OutFrame =
  | { kind: 'attach'; sessionId: string }
  | { kind: 'detach'; sessionId: string }
  | { kind: 'input'; sessionId: string; data: string }
  | { kind: 'resize'; sessionId: string; cols: number; rows: number }

export type InFrame =
  | { kind: 'output'; sessionId: string; data: string }
  | { kind: 'status' } & Record<string, unknown>

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface TermWsOptions {
  /** WebSocket URL，默认同源 /term-io */
  url?: string
  /** 重连基础间隔（指数退避），默认 1s，上限 10s */
  reconnectBaseMs?: number
  /** 注入的 WebSocket 构造器（测试用） */
  webSocketCtor?: typeof WebSocket
}

/** 一条与 /term-io 的连接。 */
export class TermWs {
  private ws: WebSocket | undefined
  private status: ConnectionStatus = 'closed'
  private readonly attached = new Set<string>()
  private readonly outputHandlers = new Map<string, (data: string) => void>()
  private statusHandler: ((frame: InFrame) => void) | undefined
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly url: string
  private readonly baseMs: number
  private readonly ctor: typeof WebSocket

  constructor(options: TermWsOptions = {}) {
    this.url = options.url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/term-io`
    this.baseMs = options.reconnectBaseMs ?? 1000
    this.ctor = options.webSocketCtor ?? WebSocket
  }

  /** 当前连接状态。 */
  getStatus(): ConnectionStatus {
    return this.status
  }

  /** 订阅某会话的输出。attach 自动触发。 */
  onOutput(sessionId: string, handler: (data: string) => void): () => void {
    this.outputHandlers.set(sessionId, handler)
    this.send({ kind: 'attach', sessionId })
    return () => {
      this.outputHandlers.delete(sessionId)
      this.send({ kind: 'detach', sessionId })
    }
  }

  /** 订阅全局状态变化帧。 */
  onStatus(handler: (frame: InFrame) => void): () => void {
    this.statusHandler = handler
    return () => { this.statusHandler = undefined }
  }

  /** 向某会话写入（键盘输入）。 */
  input(sessionId: string, data: string): void {
    this.send({ kind: 'input', sessionId, data })
  }

  /** 调整某会话终端尺寸。 */
  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ kind: 'resize', sessionId, cols, rows })
  }

  /** 打开连接（幂等；已开则无操作）。 */
  open(): void {
    if (this.ws !== undefined || this.disposed) return
    this.status = 'connecting'
    const ws = new this.ctor(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.status = 'open'
      // 重连后重新附着所有会话
      for (const sid of this.attached) this.send({ kind: 'attach', sessionId: sid })
    }
    ws.onmessage = (event) => this.onMessage(event.data)
    ws.onclose = () => {
      this.status = 'closed'
      this.ws = undefined
      if (!this.disposed) this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose 会随后触发重连
    }
  }

  /** 关闭并停止重连。 */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = undefined
    this.status = 'closed'
  }

  private onMessage(raw: unknown): void {
    let frame: InFrame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as InFrame
    } catch {
      return
    }
    if (frame.kind === 'output') {
      const handler = this.outputHandlers.get(frame.sessionId)
      handler?.(frame.data)
    } else if (frame.kind === 'status') {
      this.statusHandler?.(frame)
    }
  }

  private send(frame: OutFrame): void {
    if (this.ws !== undefined && this.status === 'open') {
      try { this.ws.send(JSON.stringify(frame)) } catch { /* 连接已断 */ }
    }
    if (frame.kind === 'attach') this.attached.add(frame.sessionId)
    else if (frame.kind === 'detach') this.attached.delete(frame.sessionId)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return
    const delay = Math.min(this.baseMs * 2 ** this.reconnectAttempt, 10_000)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }
}

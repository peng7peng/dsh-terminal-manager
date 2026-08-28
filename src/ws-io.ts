/**
 * B7b 数据流通道 —— 字符流的交换台（`/term-io` WebSocket）。
 *
 * 浏览器经通道②与此处双向通信：上行 attach/input/resize/detach，下行 output/status。
 * 订阅随连接生灭：WS 关闭时清掉该连接挂的所有订阅；30s 心跳探活。
 * MVP 信任栅栏：仅 loopback（127.0.0.1 / localhost / ::1），非 loopback 部署是后续项。
 * @module dsh-terminal-manager/ws-io
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SessionManager, SessionSnapshot } from './session-manager.ts'

const HEARTBEAT_INTERVAL_MS = 30_000

/** 上行帧（浏览器 → host）。 */
type InFrame =
  | { kind: 'attach'; sessionId: string }
  | { kind: 'detach'; sessionId: string }
  | { kind: 'input'; sessionId: string; data: string }
  | { kind: 'resize'; sessionId: string; cols: number; rows: number }

/** 下行帧（host → 浏览器）。 */
export type OutFrame =
  | { kind: 'output'; sessionId: string; data: string }
  | { kind: 'status' } & SessionSnapshot

/** 仅 loopback 信任栅栏（MVP）。 */
function isLoopback(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase()
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
}

/** 一条 WS 连接的会话订阅与帧分发（可直测：注入 ws-like 对象）。 */
export class TermIoConnection {
  private readonly subscriptions = new Map<string, () => void>()
  private readonly statusUnsub: () => void
  private closed = false

  constructor(
    private readonly ws: { send: (data: string) => void; on: (event: string, cb: (arg: unknown) => void) => void; close: () => void },
    private readonly sessions: SessionManager,
  ) {
    this.ws.on('message', this.onMessage)
    this.ws.on('close', this.onClose)
    this.statusUnsub = this.sessions.onStatus(snap => this.send({ kind: 'status', ...snap }))
  }

  send(frame: OutFrame): void {
    if (this.closed) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // 连接已断；忽略
    }
  }

  private onMessage = (raw: unknown): void => {
    let frame: InFrame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as InFrame
    } catch {
      return
    }
    const sid = frame.sessionId
    switch (frame.kind) {
      case 'attach': {
        if (this.subscriptions.has(sid)) return
        try {
          const unsub = this.sessions.subscribe(sid, data => this.send({ kind: 'output', sessionId: sid, data }))
          this.subscriptions.set(sid, unsub)
        } catch { /* 会话不存在：忽略 attach */ }
        break
      }
      case 'detach': {
        const unsub = this.subscriptions.get(sid)
        if (unsub !== undefined) { unsub(); this.subscriptions.delete(sid) }
        break
      }
      case 'input':
        try { this.sessions.write(sid, frame.data) } catch { /* 会话不存在/已断：忽略键入 */ }
        break
      case 'resize':
        try { this.sessions.resize(sid, frame.cols, frame.rows) } catch { /* 忽略 */ }
        break
    }
  }

  private onClose = (): void => {
    this.closed = true
    for (const unsub of this.subscriptions.values()) unsub()
    this.subscriptions.clear()
    this.statusUnsub()
  }
}

/**
 * 注册 /term-io WebSocket 升级路由。返回卸载函数。
 * 需 ctx.webServer（host-webserver 提供，web profile 内必就绪）。
 */
export function registerWsIo(ctx: Context, sessions: SessionManager): () => void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return () => {}
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Set<TermIoConnection>()
  const heartbeats = new Map<WebSocket, NodeJS.Timeout>()

  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isLoopback(req)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new TermIoConnection(ws as unknown as TermIoConnection['ws'], sessions)
      connections.add(conn)
      const timer = setInterval(() => {
        if ((ws as WebSocket).readyState !== ws.OPEN) return
        ;(ws as WebSocket).ping()
      }, HEARTBEAT_INTERVAL_MS)
      heartbeats.set(ws as WebSocket, timer)
      ;(ws as WebSocket).on('close', () => {
        clearInterval(timer)
        heartbeats.delete(ws as WebSocket)
        connections.delete(conn)
      })
    })
  }

  const disposer = ctx.effect(
    () => webServer.registerUpgrade({ path: '/term-io', handler }),
    'terminal-manager: /term-io WebSocket',
  )
  return () => {
    disposer?.()
    for (const timer of heartbeats.values()) clearInterval(timer)
    heartbeats.clear()
    for (const ws of wss.clients) ws.close()
    connections.clear()
  }
}

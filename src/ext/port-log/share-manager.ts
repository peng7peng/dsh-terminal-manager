import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { TmEvent, TmEventBus } from '../../types/events.ts'
import type { SessionManagerApi } from '../../types/session-api.ts'
import type { AppLogger } from './app-logger.ts'
import { PortLogError } from './errors.ts'
import { validateLocalAddress, validatePort } from './network.ts'
import type { RuntimeEventHub } from './sse.ts'
import { escapeTelnetOutput, TelnetServerCodec } from './telnet-server-codec.ts'
import type { ShareClientSnapshot, ShareConfig, ShareSnapshot } from './types.ts'

const NEGOTIATION = Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03])

interface ClientRuntime { socket: Socket; codec: TelnetServerCodec; snapshot: ShareClientSnapshot }
interface ShareRuntime { config: ShareConfig; server: Server; clients: Map<string, ClientRuntime>; unsubscribe: () => void; lastError?: string }

export class ShareManager {
  private readonly shares = new Map<string, ShareRuntime>()
  private closing = false

  constructor(
    private readonly sessions: SessionManagerApi,
    private readonly sessionEvents: TmEventBus,
    private readonly logger: AppLogger,
    private readonly events: RuntimeEventHub,
    private readonly maxBufferedBytes = 1024 * 1024,
  ) {}

  list(): ShareSnapshot[] {
    return [...this.shares.values()].map((runtime) => this.snapshot(runtime))
  }

  async start(input: ShareConfig): Promise<ShareSnapshot> {
    if (this.closing) throw new PortLogError('MAPPING_STATE', '扩展正在关闭')
    if (this.shares.has(input.sessionId)) throw new PortLogError('SHARE_ALREADY_ACTIVE', '该会话已经在共享')
    const session = this.sessions.get(input.sessionId)
    if (session?.status !== 'open') throw new PortLogError('VALIDATION', '只能共享已打开的会话')
    const config = this.validate(input)
    const clients = new Map<string, ClientRuntime>()
    const server = createServer((socket) => this.accept(config.sessionId, socket))
    const runtime: ShareRuntime = { config, server, clients, unsubscribe: () => undefined }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.sharePort, config.localAddr, resolve)
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') throw new PortLogError('PORT_IN_USE', '共享端口已被占用')
      throw new PortLogError('IO_ERROR', '会话共享启动失败')
    }
    runtime.unsubscribe = this.sessionEvents.on(
      (event) => this.handleSessionEvent(config.sessionId, event),
      { type: ['output', 'status'], sessionId: config.sessionId },
    )
    server.on('error', () => {
      runtime.lastError = '共享服务运行错误'
      this.publish(runtime)
    })
    this.shares.set(config.sessionId, runtime)
    await this.logger.log('info', 'share.started', { sessionId: config.sessionId, localAddr: config.localAddr, sharePort: config.sharePort })
    this.publish(runtime)
    return this.snapshot(runtime)
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.shares.get(sessionId)
    if (runtime === undefined) return
    await this.stopRuntime(runtime)
  }

  async stopAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.shares.values()].map((runtime) => this.stopRuntime(runtime)))
  }

  private accept(sessionId: string, socket: Socket): void {
    const runtime = this.shares.get(sessionId)
    if (runtime === undefined) {
      socket.destroy()
      return
    }
    if (runtime.config.maxClients > 0 && runtime.clients.size >= runtime.config.maxClients) {
      socket.end('共享客户端数量已达上限\r\n')
      return
    }
    const id = randomUUID()
    const client: ClientRuntime = {
      socket,
      codec: new TelnetServerCodec(),
      snapshot: {
        id,
        remoteAddress: socket.remoteAddress ?? 'unknown',
        connectedAtMs: Date.now(),
        bytesToClient: 0,
        bytesFromClient: 0,
      },
    }
    runtime.clients.set(id, client)
    socket.write(NEGOTIATION)
    if (runtime.config.welcomeMessage.length > 0) socket.write(`${runtime.config.welcomeMessage}\r\n`)
    socket.on('data', (chunk: Buffer) => {
      client.snapshot.bytesFromClient += chunk.length
      const data = client.codec.push(chunk)
      if (data.length > 0) this.sessions.write(sessionId, data)
      this.publish(runtime)
    })
    socket.on('error', () => undefined)
    socket.once('close', () => {
      const tail = client.codec.end()
      if (tail.length > 0 && this.sessions.get(sessionId)?.status === 'open') this.sessions.write(sessionId, tail)
      runtime.clients.delete(id)
      void this.logger.log('info', 'share.client_disconnected', { sessionId, clientId: id })
      this.publish(runtime)
    })
    void this.logger.log('info', 'share.client_connected', { sessionId, clientId: id, remoteAddress: client.snapshot.remoteAddress })
    this.publish(runtime)
  }

  private handleSessionEvent(sessionId: string, event: TmEvent): void {
    const runtime = this.shares.get(sessionId)
    if (runtime === undefined) return
    if (event.type === 'status') {
      if (event.status === 'closed' || event.status === 'removed') void this.stopRuntime(runtime)
      return
    }
    if (event.type !== 'output') return
    const payload = escapeTelnetOutput(event.data)
    for (const [id, client] of runtime.clients) {
      if (client.socket.writableLength + payload.length > this.maxBufferedBytes) {
        runtime.clients.delete(id)
        client.socket.destroy()
        continue
      }
      client.snapshot.bytesToClient += payload.length
      client.socket.write(payload)
      if (client.socket.writableLength > this.maxBufferedBytes) {
        runtime.clients.delete(id)
        client.socket.destroy()
      }
    }
    this.publish(runtime)
  }

  private async stopRuntime(runtime: ShareRuntime): Promise<void> {
    if (!this.shares.delete(runtime.config.sessionId)) return
    runtime.unsubscribe()
    const closed = new Promise<void>((resolve) => {
      try { runtime.server.close(() => resolve()) } catch { resolve() }
    })
    for (const client of runtime.clients.values()) client.socket.destroy()
    runtime.clients.clear()
    await closed
    await this.logger.log('info', 'share.stopped', { sessionId: runtime.config.sessionId })
    this.events.publish({ type: 'share-removed', data: { sessionId: runtime.config.sessionId } })
  }

  private validate(input: ShareConfig): ShareConfig {
    if (!Number.isInteger(input.maxClients) || input.maxClients < 0 || input.maxClients > 10_000) {
      throw new PortLogError('VALIDATION', 'maxClients 必须是 0–10000 的整数')
    }
    if (typeof input.welcomeMessage !== 'string' || input.welcomeMessage.length > 512) {
      throw new PortLogError('VALIDATION', '欢迎语不能超过 512 个字符')
    }
    return {
      sessionId: input.sessionId,
      localAddr: validateLocalAddress(input.localAddr),
      sharePort: validatePort(input.sharePort, '共享端口'),
      maxClients: input.maxClients,
      welcomeMessage: input.welcomeMessage,
    }
  }

  private snapshot(runtime: ShareRuntime): ShareSnapshot {
    return {
      ...runtime.config,
      state: runtime.lastError === undefined ? 'running' : 'error',
      clients: [...runtime.clients.values()].map((client) => ({ ...client.snapshot })),
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
    }
  }

  private publish(runtime: ShareRuntime): void {
    this.events.publish({ type: 'share-status', data: this.snapshot(runtime) })
  }
}

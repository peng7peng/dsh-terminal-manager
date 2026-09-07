import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { PortLogError } from './errors.ts'
import type { ForwarderStats, PortMappingConfig } from './types.ts'

interface SocketPair { client: Socket; target: Socket }

function networkError(error: unknown): PortLogError {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') return new PortLogError('PORT_IN_USE', '监听端口已被占用')
  if (code === 'EADDRNOTAVAIL' || code === 'EINVAL') return new PortLogError('ADDRESS_INVALID', '监听地址不可用')
  return new PortLogError('IO_ERROR', 'TCP 映射启动失败')
}

export class TcpForwarder {
  private server?: Server
  private readonly pairs = new Set<SocketPair>()
  private stats: ForwarderStats = { activeCount: 0, bytesClientToTarget: 0, bytesTargetToClient: 0 }
  private stopping = false

  constructor(
    private readonly config: PortMappingConfig,
    private readonly onStats: (stats: ForwarderStats) => void,
    private readonly connectTimeoutMs = 3000,
    private readonly drainTimeoutMs = 2000,
  ) {}

  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.stopping = false
    const server = createServer({ allowHalfOpen: true }, (client) => this.accept(client))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.server = undefined
        reject(networkError(error))
      }
      const onListening = (): void => {
        server.off('error', onError)
        server.on('error', (error) => this.reportError(networkError(error).message))
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.localPort, this.config.localAddr)
    })
  }

  async stop(): Promise<void> {
    if (this.server === undefined && this.pairs.size === 0) return
    this.stopping = true
    const server = this.server
    this.server = undefined
    let serverClosed: Promise<void> = Promise.resolve()
    if (server !== undefined) {
      serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (this.pairs.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.drainTimeoutMs)
        timer.unref()
        const poll = (): void => {
          if (this.pairs.size === 0) {
            clearTimeout(timer)
            resolve()
          } else setTimeout(poll, 10).unref()
        }
        poll()
      })
    }
    for (const pair of this.pairs) {
      pair.client.destroy()
      pair.target.destroy()
    }
    this.pairs.clear()
    await serverClosed
    this.stats.activeCount = 0
    this.emitStats()
  }

  private accept(client: Socket): void {
    if (this.stopping) {
      client.destroy()
      return
    }
    client.pause()
    const target = createConnection({ host: this.config.redirectAddr, port: this.config.redirectPort, allowHalfOpen: true })
    const pair = { client, target }
    let connected = false
    const timeout = setTimeout(() => {
      if (!connected) {
        this.reportError('目标连接超时')
        client.destroy()
        target.destroy()
      }
    }, this.connectTimeoutMs)
    timeout.unref()

    target.once('connect', () => {
      connected = true
      clearTimeout(timeout)
      this.pairs.add(pair)
      this.stats.activeCount = this.pairs.size
      this.emitStats()
      client.on('data', (chunk: Buffer) => {
        this.stats.bytesClientToTarget += chunk.length
        this.emitStats()
      })
      target.on('data', (chunk: Buffer) => {
        this.stats.bytesTargetToClient += chunk.length
        this.emitStats()
      })
      client.pipe(target)
      target.pipe(client)
      client.resume()
    })

    const fail = (): void => {
      clearTimeout(timeout)
      if (!connected) this.reportError('目标连接失败')
      client.destroy()
      target.destroy()
    }
    target.on('error', fail)
    client.on('error', () => {
      target.destroy()
    })
    let closed = 0
    const onClose = (): void => {
      closed += 1
      if (closed < 2) return
      if (this.pairs.delete(pair)) {
        this.stats.activeCount = this.pairs.size
        this.emitStats()
      }
    }
    client.once('close', onClose)
    target.once('close', onClose)
  }

  private reportError(message: string): void {
    this.stats.lastError = message
    this.emitStats()
  }

  private emitStats(): void {
    this.onStats({ ...this.stats })
  }
}

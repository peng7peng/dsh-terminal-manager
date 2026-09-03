import { lookup } from 'node:dns/promises'
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { isIP } from 'node:net'
import { PortLogError } from './errors.ts'
import type { ForwarderStats, PortMappingConfig } from './types.ts'

interface Peer {
  socket: Socket
  source: RemoteInfo
  lastSeen: number
  pendingPackets: number
  pendingBytes: number
}

function peerKey(source: RemoteInfo): string {
  return `${source.family}|${source.address}|${source.port}`
}

export class UdpForwarder {
  private listener?: Socket
  private readonly peers = new Map<string, Peer>()
  private sweep?: NodeJS.Timeout
  private target?: { address: string; family: 4 | 6 }
  private stats: ForwarderStats = { activeCount: 0, bytesClientToTarget: 0, bytesTargetToClient: 0 }

  constructor(
    private readonly config: PortMappingConfig,
    private readonly onStats: (stats: ForwarderStats) => void,
    private readonly idleMs = 60_000,
    private readonly sweepMs = 10_000,
    private readonly maxPeers = 1024,
  ) {}

  async start(): Promise<void> {
    if (this.listener !== undefined) return
    try {
      const resolved = await lookup(this.config.redirectAddr, { family: 0 })
      this.target = { address: resolved.address, family: resolved.family as 4 | 6 }
      const family = isIP(this.config.localAddr) === 6 ? 'udp6' : 'udp4'
      const listener = createSocket(family)
      this.listener = listener
      listener.on('message', (message, source) => this.forward(message, source))
      listener.on('error', () => this.reportError('UDP 映射运行错误'))
      await new Promise<void>((resolve, reject) => {
        listener.once('listening', resolve)
        listener.once('error', reject)
        listener.bind(this.config.localPort, this.config.localAddr)
      })
      this.sweep = setInterval(() => this.sweepIdle(), this.sweepMs)
      this.sweep.unref()
    } catch (error) {
      await this.stop()
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') throw new PortLogError('PORT_IN_USE', '监听端口已被占用')
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new PortLogError('TARGET_UNREACHABLE', '目标地址无法解析')
      throw error instanceof PortLogError ? error : new PortLogError('IO_ERROR', 'UDP 映射启动失败')
    }
  }

  async stop(): Promise<void> {
    if (this.sweep !== undefined) clearInterval(this.sweep)
    this.sweep = undefined
    for (const peer of this.peers.values()) peer.socket.close()
    this.peers.clear()
    this.stats.activeCount = 0
    const listener = this.listener
    this.listener = undefined
    if (listener !== undefined) {
      await new Promise<void>((resolve) => {
        try { listener.close(() => resolve()) } catch { resolve() }
      })
    }
    this.emitStats()
  }

  private forward(message: Buffer, source: RemoteInfo): void {
    const target = this.target
    const listener = this.listener
    if (target === undefined || listener === undefined) return
    const key = peerKey(source)
    let peer = this.peers.get(key)
    if (peer === undefined) {
      if (this.peers.size >= this.maxPeers) {
        this.reportError('UDP 来源端点数量已达上限')
        return
      }
      const socket = createSocket(target.family === 6 ? 'udp6' : 'udp4')
      peer = { socket, source, lastSeen: Date.now(), pendingPackets: 0, pendingBytes: 0 }
      this.peers.set(key, peer)
      socket.on('message', (reply) => {
        const currentListener = this.listener
        if (currentListener === undefined) return
        currentListener.send(reply, peer!.source.port, peer!.source.address)
        this.stats.bytesTargetToClient += reply.length
        this.emitStats()
      })
      socket.on('error', () => {
        this.removePeer(key)
        this.reportError('UDP 目标通信失败')
      })
      this.stats.activeCount = this.peers.size
    }
    peer.lastSeen = Date.now()
    if (peer.pendingPackets >= 64 || peer.pendingBytes + message.length > 1024 * 1024) {
      this.reportError('UDP 来源端点待发送数据已达上限')
      return
    }
    peer.pendingPackets += 1
    peer.pendingBytes += message.length
    peer.socket.send(message, this.config.redirectPort, target.address, () => {
      peer!.pendingPackets -= 1
      peer!.pendingBytes -= message.length
    })
    this.stats.bytesClientToTarget += message.length
    this.emitStats()
  }

  private sweepIdle(): void {
    const deadline = Date.now() - this.idleMs
    for (const [key, peer] of this.peers) if (peer.lastSeen <= deadline) this.removePeer(key)
  }

  private removePeer(key: string): void {
    const peer = this.peers.get(key)
    if (peer === undefined) return
    this.peers.delete(key)
    try { peer.socket.close() } catch { /* already closed */ }
    this.stats.activeCount = this.peers.size
    this.emitStats()
  }

  private reportError(message: string): void {
    this.stats.lastError = message
    this.emitStats()
  }

  private emitStats(): void {
    this.onStats({ ...this.stats })
  }
}

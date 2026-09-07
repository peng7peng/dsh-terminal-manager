import type { AppLogger } from './app-logger.ts'
import { PortLogError, safeError } from './errors.ts'
import type { MappingStore } from './mapping-store.ts'
import type { RuntimeEventHub } from './sse.ts'
import { TcpForwarder } from './tcp-forwarder.ts'
import type { ForwarderStats, MappingSnapshot, PortMappingConfig, PortMappingInput } from './types.ts'
import { UdpForwarder } from './udp-forwarder.ts'

interface Forwarder { start(): Promise<void>; stop(): Promise<void> }

export class MappingManager {
  private readonly runtimes = new Map<string, Forwarder>()
  private readonly snapshots = new Map<string, MappingSnapshot>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly notifications = new Map<string, NodeJS.Timeout>()
  private closing = false

  constructor(
    private readonly store: MappingStore,
    private readonly logger: AppLogger,
    private readonly events: RuntimeEventHub,
  ) {}

  async initialize(): Promise<void> {
    await this.store.ensureLoaded()
    for (const config of this.store.list()) this.snapshots.set(config.id, this.initialSnapshot(config))
  }

  list(): MappingSnapshot[] {
    return this.store.list().map((config) => ({ ...(this.snapshots.get(config.id) ?? this.initialSnapshot(config)) }))
  }

  async create(input: PortMappingInput): Promise<MappingSnapshot> {
    this.assertOpen()
    const config = await this.store.create(input)
    const snapshot = this.initialSnapshot(config)
    this.snapshots.set(config.id, snapshot)
    this.publish(snapshot)
    return { ...snapshot }
  }

  async merge(inputs: readonly PortMappingInput[]): Promise<MappingSnapshot[]> {
    this.assertOpen()
    const configs = await this.store.merge(inputs)
    return configs.map((config) => {
      const snapshot = this.initialSnapshot(config)
      this.snapshots.set(config.id, snapshot)
      this.publish(snapshot)
      return { ...snapshot }
    })
  }

  update(id: string, patch: Partial<PortMappingInput>): Promise<MappingSnapshot> {
    return this.enqueue(id, async () => {
      this.assertOpen()
      const wasRunning = this.runtimes.has(id)
      if (wasRunning) await this.stopRuntime(id)
      const config = await this.store.update(id, patch)
      const snapshot = this.initialSnapshot(config)
      this.snapshots.set(id, snapshot)
      if (wasRunning) await this.startRuntime(config)
      else this.publish(snapshot)
      return { ...this.snapshots.get(id)! }
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      this.assertOpen()
      await this.stopRuntime(id)
      await this.store.remove(id)
      this.snapshots.delete(id)
      this.events.publish({ type: 'mapping-removed', data: { id } })
    })
  }

  start(id: string): Promise<MappingSnapshot> {
    return this.enqueue(id, async () => {
      this.assertOpen()
      const existing = this.snapshots.get(id)
      if (existing === undefined) throw new PortLogError('MAPPING_NOT_FOUND', '端口映射不存在')
      if (this.runtimes.has(id)) return { ...existing }
      const config = this.store.list().find((item) => item.id === id)
      if (config === undefined) throw new PortLogError('MAPPING_NOT_FOUND', '端口映射不存在')
      await this.startRuntime(config)
      return { ...this.snapshots.get(id)! }
    })
  }

  stop(id: string): Promise<MappingSnapshot> {
    return this.enqueue(id, async () => {
      if (!this.snapshots.has(id)) throw new PortLogError('MAPPING_NOT_FOUND', '端口映射不存在')
      await this.stopRuntime(id)
      return { ...this.snapshots.get(id)! }
    })
  }

  async autoStart(): Promise<void> {
    const configs = this.store.list().filter((item) => item.autoStart)
    await Promise.allSettled(configs.map((item) => this.start(item.id)))
  }

  async stopAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.runtimes.keys()].map((id) => this.enqueue(id, () => this.stopRuntime(id))))
    for (const timer of this.notifications.values()) clearTimeout(timer)
    this.notifications.clear()
  }

  private async startRuntime(config: PortMappingConfig): Promise<void> {
    this.setState(config.id, 'starting')
    const onStats = (stats: ForwarderStats): void => this.updateStats(config.id, stats)
    const runtime = config.protocol === 'tcp'
      ? new TcpForwarder(config, onStats)
      : new UdpForwarder(config, onStats)
    try {
      await runtime.start()
      this.runtimes.set(config.id, runtime)
      this.setState(config.id, 'running')
      await this.logger.log('info', 'mapping.started', { id: config.id, protocol: config.protocol, localAddr: config.localAddr, localPort: config.localPort })
    } catch (error) {
      const safe = safeError(error)
      this.updateStats(config.id, { activeCount: 0, bytesClientToTarget: 0, bytesTargetToClient: 0, lastError: safe.message })
      this.setState(config.id, 'error')
      await this.logger.log('error', 'mapping.start_failed', { id: config.id, code: safe.code })
      throw error
    }
  }

  private async stopRuntime(id: string): Promise<void> {
    const snapshot = this.snapshots.get(id)
    if (snapshot === undefined) return
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) {
      this.setState(id, 'stopped')
      return
    }
    this.setState(id, 'stopping')
    try {
      await runtime.stop()
    } finally {
      this.runtimes.delete(id)
      this.setState(id, 'stopped')
      await this.logger.log('info', 'mapping.stopped', { id })
    }
  }

  private updateStats(id: string, stats: ForwarderStats): void {
    const snapshot = this.snapshots.get(id)
    if (snapshot === undefined) return
    Object.assign(snapshot, stats)
    if (stats.lastError !== undefined) {
      this.publish(snapshot)
      return
    }
    if (this.notifications.has(id)) return
    const timer = setTimeout(() => {
      this.notifications.delete(id)
      const latest = this.snapshots.get(id)
      if (latest !== undefined) this.publish(latest)
    }, 500)
    timer.unref()
    this.notifications.set(id, timer)
  }

  private setState(id: string, state: MappingSnapshot['state']): void {
    const snapshot = this.snapshots.get(id)
    if (snapshot === undefined) return
    snapshot.state = state
    this.publish(snapshot)
  }

  private publish(snapshot: MappingSnapshot): void {
    this.events.publish({ type: 'mapping-status', data: { ...snapshot } })
  }

  private initialSnapshot(config: PortMappingConfig): MappingSnapshot {
    return { ...config, state: 'stopped', activeCount: 0, bytesClientToTarget: 0, bytesTargetToClient: 0 }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operations.set(id, current)
    void current.finally(() => {
      if (this.operations.get(id) === current) this.operations.delete(id)
    }).catch(() => undefined)
    return current
  }

  private assertOpen(): void {
    if (this.closing) throw new PortLogError('MAPPING_STATE', '扩展正在关闭')
  }
}

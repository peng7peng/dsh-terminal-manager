import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PortLogError } from './errors.ts'
import { validateLocalAddress, validatePort, validateTarget } from './network.ts'
import type { PortMappingConfig, PortMappingInput } from './types.ts'

interface MappingFile { version: 1; mappings: PortMappingConfig[] }

export function validateMappingInput(input: PortMappingInput): PortMappingInput {
  if (input.protocol !== 'tcp' && input.protocol !== 'udp') {
    throw new PortLogError('VALIDATION', '协议必须是 tcp 或 udp')
  }
  if (typeof input.autoStart !== 'boolean') throw new PortLogError('VALIDATION', 'autoStart 必须是布尔值')
  return {
    protocol: input.protocol,
    localAddr: validateLocalAddress(input.localAddr),
    localPort: validatePort(input.localPort, '本地端口'),
    redirectAddr: validateTarget(input.redirectAddr),
    redirectPort: validatePort(input.redirectPort, '目标端口'),
    autoStart: input.autoStart,
  }
}

function listenerKey(config: Pick<PortMappingConfig, 'protocol' | 'localAddr' | 'localPort'>): string {
  return `${config.protocol}|${config.localAddr}|${config.localPort}`
}

export class MappingStore {
  private mappings: PortMappingConfig[] = []
  private loaded = false

  constructor(private readonly path: string) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<MappingFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) throw new Error('invalid version')
      const seenIds = new Set<string>()
      const seenListeners = new Set<string>()
      this.mappings = parsed.mappings.map((item) => {
        if (typeof item.id !== 'string' || item.id.length === 0 || seenIds.has(item.id)) throw new Error('invalid id')
        const validated = { id: item.id, ...validateMappingInput(item) }
        const key = listenerKey(validated)
        if (seenListeners.has(key)) throw new Error('duplicate listener')
        seenIds.add(item.id)
        seenListeners.add(key)
        return validated
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PortLogError('IO_ERROR', '端口映射配置无法读取')
      }
      this.mappings = []
    }
    this.loaded = true
  }

  list(): PortMappingConfig[] {
    this.assertLoaded()
    return this.mappings.map((item) => ({ ...item }))
  }

  async create(input: PortMappingInput): Promise<PortMappingConfig> {
    this.assertLoaded()
    const item = { id: randomUUID(), ...validateMappingInput(input) }
    this.assertUnique(item)
    this.mappings.push(item)
    await this.persistOrRollback(() => this.mappings.pop())
    return { ...item }
  }

  async update(id: string, patch: Partial<PortMappingInput>): Promise<PortMappingConfig> {
    this.assertLoaded()
    const index = this.mappings.findIndex((item) => item.id === id)
    if (index < 0) throw new PortLogError('MAPPING_NOT_FOUND', '端口映射不存在')
    const previous = this.mappings[index]!
    const next = { id, ...validateMappingInput({ ...previous, ...patch }) }
    this.assertUnique(next, id)
    this.mappings[index] = next
    await this.persistOrRollback(() => { this.mappings[index] = previous })
    return { ...next }
  }

  async remove(id: string): Promise<void> {
    this.assertLoaded()
    const index = this.mappings.findIndex((item) => item.id === id)
    if (index < 0) throw new PortLogError('MAPPING_NOT_FOUND', '端口映射不存在')
    const [removed] = this.mappings.splice(index, 1)
    await this.persistOrRollback(() => { this.mappings.splice(index, 0, removed!) })
  }

  async merge(inputs: readonly PortMappingInput[]): Promise<PortMappingConfig[]> {
    this.assertLoaded()
    const additions = inputs.map((input) => ({ id: randomUUID(), ...validateMappingInput(input) }))
    const keys = new Set(this.mappings.map(listenerKey))
    for (const item of additions) {
      const key = listenerKey(item)
      if (keys.has(key)) throw new PortLogError('VALIDATION', '监听地址、端口和协议重复')
      keys.add(key)
    }
    this.mappings.push(...additions)
    await this.persistOrRollback(() => { this.mappings.splice(this.mappings.length - additions.length, additions.length) })
    return additions.map((item) => ({ ...item }))
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new PortLogError('IO_ERROR', '端口映射配置尚未加载')
  }

  private assertUnique(config: PortMappingConfig, excludingId?: string): void {
    const key = listenerKey(config)
    if (this.mappings.some((item) => item.id !== excludingId && listenerKey(item) === key)) {
      throw new PortLogError('VALIDATION', '监听地址、端口和协议重复')
    }
  }

  private async persistOrRollback(rollback: () => void): Promise<void> {
    try {
      await this.persist()
    } catch {
      rollback()
      throw new PortLogError('IO_ERROR', '端口映射配置无法保存')
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, mappings: this.mappings }, null, 2), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

/**
 * B1 连接存储 —— 设备清单的"档案室"。
 *
 * 连接配置的增删改查 + 校验 + JSON 落盘（权限尽力限为仅本人，含 Windows 尽力处理）。
 * 只依赖文件系统，是最底层模块。校验错误永远不回显凭据内容。
 * @module dsh-terminal-manager/connection-store
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WAIT_LIMITS } from './wait-policy.ts'

export type Protocol = 'ssh' | 'telnet'

export type AuthConfig =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase?: string }

export interface ConnectionConfig {
  id: string
  label: string
  protocol: Protocol
  host: string
  port: number
  username?: string
  auth?: AuthConfig
  /** 完成判定：提示符正则（可选） */
  promptPattern?: string
  /** 完成判定：静默期覆盖（可选） */
  quietMs?: number
  /** 完成判定：超时覆盖（可选） */
  timeoutMs?: number
  /** 命令守卫白名单（可选，正则源列表） */
  guardWhitelist?: string[]
  note?: string
}

/** 新建/更新的输入（id 由存储分配，port 缺省按协议取默认）。 */
export type ConnectionInput = Omit<ConnectionConfig, 'id' | 'port'> & { port?: number }

/** 校验失败（错误消息不含任何凭据内容）。 */
export class StoreValidationError extends Error {
  readonly code = 'VALIDATION' as const
}

/** 目标不存在。 */
export class StoreNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND' as const
}

const DEFAULT_PORTS: Record<Protocol, number> = { ssh: 22, telnet: 23 }

/** 校验一条完整配置；有问题直接抛，消息只描述字段不描述值。 */
function validate(cfg: ConnectionConfig): void {
  const fail = (message: string): never => {
    throw new StoreValidationError(message)
  }
  if (typeof cfg.label !== 'string' || cfg.label.trim().length === 0) fail('名称不能为空')
  if (cfg.protocol !== 'ssh' && cfg.protocol !== 'telnet') fail('协议必须是 ssh 或 telnet')
  if (typeof cfg.host !== 'string' || cfg.host.trim().length === 0) fail('IP 地址不能为空')
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail('端口必须是 1–65535 的整数')
  if (cfg.protocol === 'ssh') {
    if (typeof cfg.username !== 'string' || cfg.username.trim().length === 0) fail('SSH 登录需要用户名')
    if (cfg.auth === undefined) fail('SSH 需要认证方式（密码或密钥）')
    if (cfg.auth.kind === 'password' && cfg.auth.password.length === 0) fail('选择了密码认证时密码不能为空')
    if (cfg.auth.kind === 'key' && cfg.auth.privateKey.trim().length === 0) fail('选择了密钥认证时私钥不能为空')
  }
  if (cfg.promptPattern !== undefined) {
    try {
      void new RegExp(cfg.promptPattern)
    } catch {
      fail('提示符正则不合法')
    }
  }
  if (cfg.quietMs !== undefined && (cfg.quietMs < WAIT_LIMITS.quietMs.min || cfg.quietMs > WAIT_LIMITS.quietMs.max)) {
    fail(`静默期必须在 ${WAIT_LIMITS.quietMs.min}–${WAIT_LIMITS.quietMs.max} 毫秒之间`)
  }
  if (cfg.timeoutMs !== undefined && (cfg.timeoutMs < WAIT_LIMITS.timeoutMs.min || cfg.timeoutMs > WAIT_LIMITS.timeoutMs.max)) {
    fail(`超时必须在 ${WAIT_LIMITS.timeoutMs.min}–${WAIT_LIMITS.timeoutMs.max} 毫秒之间`)
  }
}

/** 连接清单的存取。一个实例对应一个落盘文件。 */
export class ConnectionStore {
  private readonly connections = new Map<string, ConnectionConfig>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  /** 读取落盘文件；不存在则为空清单。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw error
    }
    const parsed = JSON.parse(raw) as { connections?: ConnectionConfig[] }
    this.connections.clear()
    for (const cfg of parsed.connections ?? []) {
      validate(cfg)
      this.connections.set(cfg.id, cfg)
    }
    this.loaded = true
  }

  list(): ConnectionConfig[] {
    return [...this.connections.values()]
  }

  get(id: string): ConnectionConfig | undefined {
    return this.connections.get(id)
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    const cfg: ConnectionConfig = {
      ...input,
      id: randomUUID(),
      port: input.port ?? DEFAULT_PORTS[input.protocol],
    }
    validate(cfg)
    this.connections.set(cfg.id, cfg)
    await this.persist()
    return cfg
  }

  async update(id: string, patch: Partial<ConnectionInput>): Promise<ConnectionConfig> {
    const existing = this.connections.get(id)
    if (existing === undefined) throw new StoreNotFoundError(`连接不存在: ${id}`)
    const merged: ConnectionConfig = {
      ...existing,
      ...patch,
      id: existing.id,
      port: patch.port ?? existing.port,
      protocol: patch.protocol ?? existing.protocol,
    }
    validate(merged)
    this.connections.set(id, merged)
    await this.persist()
    return merged
  }

  async remove(id: string): Promise<void> {
    if (!this.connections.delete(id)) throw new StoreNotFoundError(`连接不存在: ${id}`)
    await this.persist()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const payload = JSON.stringify({ version: 1, connections: [...this.connections.values()] }, null, 2)
    await fs.writeFile(this.filePath, payload, 'utf8')
    try {
      await fs.chmod(this.filePath, 0o600)
    } catch {
      // 权限模型差异（如 Windows）：尽力而为，不阻断功能
    }
  }
}

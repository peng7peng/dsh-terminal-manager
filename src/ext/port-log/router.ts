import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { AppLogger } from './app-logger.ts'
import { exportMappingsCsv, parseMappingsCsv } from './csv.ts'
import { resolveKnownFolders } from './known-folders.ts'
import { PortLogError, safeError } from './errors.ts'
import type { MappingStore } from './mapping-store.ts'
import type { MappingManager } from './mapping-manager.ts'
import { localAddresses } from './network.ts'
import type { RuntimeEventHub } from './sse.ts'
import type { ShareManager } from './share-manager.ts'
import type { SessionManagerApi } from '../../types/session-api.ts'
import type { SessionLogManager } from './session-log-manager.ts'
import type { PortMappingInput } from './types.ts'

const PREFIX = '/term-manager/ext/port-log'
const MAX_BODY_BYTES = 2 * 1024 * 1024

interface RouterDeps {
  store: MappingStore
  mappings?: MappingManager
  shares?: ShareManager
  sessions?: SessionManagerApi
  sessionLogs?: SessionLogManager
  logger: AppLogger
  events: RuntimeEventHub
  ready: Promise<void>
  pickDirectory?: (signal: AbortSignal) => Promise<string | null>
}

type Payload = Record<string, unknown>
type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%')[0]
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.')
}

export function isAllowedRequest(request: IncomingMessage): boolean {
  if (!isLoopback(request.socket.remoteAddress)) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  try {
    return host !== undefined && new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function requireString(payload: Payload, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) throw new PortLogError('VALIDATION', `${key} 无效`)
  return value
}

export async function dispatchPortLog(endpoint: string, payload: Payload, deps: RouterDeps, signal: AbortSignal = new AbortController().signal): Promise<RpcResult> {
  try {
    await deps.ready
    switch (endpoint) {
      case 'appLogs.status':
        return ok(await deps.logger.status())
      case 'network.localAddresses':
        return ok(localAddresses())
      case 'mappings.list':
        return ok(deps.mappings?.list() ?? deps.store.list())
      case 'mappings.create': {
        const created = deps.mappings === undefined
          ? await deps.store.create(payload as unknown as PortMappingInput)
          : await deps.mappings.create(payload as unknown as PortMappingInput)
        deps.events.publish({ type: 'mapping-status', data: created })
        await deps.logger.log('info', 'mapping.created', { id: created.id, protocol: created.protocol, localAddr: created.localAddr, localPort: created.localPort })
        return ok(created)
      }
      case 'mappings.update': {
        const id = requireString(payload, 'id')
        const patch = payload.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new PortLogError('VALIDATION', 'patch 无效')
        const updated = deps.mappings === undefined
          ? await deps.store.update(id, patch as Partial<PortMappingInput>)
          : await deps.mappings.update(id, patch as Partial<PortMappingInput>)
        deps.events.publish({ type: 'mapping-status', data: updated })
        await deps.logger.log('info', 'mapping.updated', { id })
        return ok(updated)
      }
      case 'mappings.remove': {
        const id = requireString(payload, 'id')
        if (deps.mappings === undefined) await deps.store.remove(id)
        else await deps.mappings.remove(id)
        deps.events.publish({ type: 'mapping-removed', data: { id } })
        await deps.logger.log('info', 'mapping.removed', { id })
        return ok({ id })
      }
      case 'mappings.importCsv': {
        const csv = requireString(payload, 'csv')
        const inputs = parseMappingsCsv(csv)
        const created = deps.mappings === undefined ? await deps.store.merge(inputs) : await deps.mappings.merge(inputs)
        for (const item of created) deps.events.publish({ type: 'mapping-status', data: item })
        await deps.logger.log('info', 'mapping.csv_imported', { count: created.length })
        return ok({ count: created.length, mappings: created })
      }
      case 'mappings.exportCsv':
        return ok({ csv: exportMappingsCsv(deps.mappings?.list() ?? deps.store.list()) })
      case 'mappings.start': {
        if (deps.mappings === undefined) throw new PortLogError('MAPPING_STATE', '映射运行时尚未就绪')
        return ok(await deps.mappings.start(requireString(payload, 'id')))
      }
      case 'mappings.stop': {
        if (deps.mappings === undefined) throw new PortLogError('MAPPING_STATE', '映射运行时尚未就绪')
        return ok(await deps.mappings.stop(requireString(payload, 'id')))
      }
      case 'sessions.list':
        if (deps.sessions === undefined) throw new PortLogError('MAPPING_STATE', '会话服务尚未就绪')
        return ok(deps.sessions.list())
      case 'shares.list':
        return ok(deps.shares?.list() ?? [])
      case 'shares.start': {
        if (deps.shares === undefined) throw new PortLogError('MAPPING_STATE', '共享服务尚未就绪')
        return ok(await deps.shares.start({
          sessionId: requireString(payload, 'sessionId'),
          localAddr: typeof payload.localAddr === 'string' ? payload.localAddr : '0.0.0.0',
          sharePort: payload.sharePort as number,
          maxClients: payload.maxClients === undefined ? 0 : payload.maxClients as number,
          welcomeMessage: payload.welcomeMessage === undefined ? '' : payload.welcomeMessage as string,
        }))
      }
      case 'shares.stop': {
        if (deps.shares === undefined) throw new PortLogError('MAPPING_STATE', '共享服务尚未就绪')
        const sessionId = requireString(payload, 'sessionId')
        await deps.shares.stop(sessionId)
        return ok({ sessionId })
      }
      case 'sessionLogs.list':
        return ok(deps.sessionLogs?.list() ?? [])
      case 'sessionLogs.defaultDirectory':
        return ok({ directory: deps.sessionLogs?.getDefaultDirectory() ?? '' })
      case 'sessionLogs.start': {
        if (deps.sessionLogs === undefined) throw new PortLogError('MAPPING_STATE', '会话日志服务尚未就绪')
        const directory = typeof payload.directory === 'string' && payload.directory.trim() !== '' ? payload.directory.trim() : undefined
        return ok(await deps.sessionLogs.start(requireString(payload, 'sessionId'), {
          timestamp: payload.timestamp === true,
          stripAnsi: payload.stripAnsi !== false,
        }, directory))
      }
      case 'sessionLogs.update': {
        if (deps.sessionLogs === undefined) throw new PortLogError('MAPPING_STATE', '会话日志服务尚未就绪')
        return ok(await deps.sessionLogs.update(requireString(payload, 'sessionId'), {
          timestamp: payload.timestamp === true,
          stripAnsi: payload.stripAnsi !== false,
        }))
      }
      case 'sessionLogs.stop': {
        if (deps.sessionLogs === undefined) throw new PortLogError('MAPPING_STATE', '会话日志服务尚未就绪')
        const sessionId = requireString(payload, 'sessionId')
        await deps.sessionLogs.stop(sessionId)
        return ok({ sessionId })
      }
      case 'sessionLogs.pickDirectory': {
        if (!deps.pickDirectory) throw new PortLogError('IO_ERROR', '当前 DSH 未启用系统目录选择器')
        return ok({ directory: await deps.pickDirectory(signal) })
      }
      case 'sessionLogs.listDir': {
        const raw = typeof payload.path === 'string' ? payload.path.trim() : ''
        const dir = raw === '' ? deps.sessionLogs?.getDefaultDirectory() ?? homedir() : resolve(raw)
        try {
          const entries = await readdir(dir, { withFileTypes: true })
          const dirs = entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          // 文件系统根（Windows 盘符根 / POSIX /）之上是「此电脑」，parent 返回 null 由前端展示
          const isRoot = sep === '/' ? dir === '/' : /^[A-Za-z]:[\\/]?$/.test(dir)
          const parent = isRoot ? null : resolve(dir, '..')
          return ok({ path: dir, parent, dirs })
        } catch {
          throw new PortLogError('IO_ERROR', `无法读取目录：${dir}`)
        }
      }
      case 'sessionLogs.knownFolders':
        return ok(await resolveKnownFolders())
      default:
        throw new PortLogError('VALIDATION', '未知方法')
    }
  } catch (error) {
    const safe = safeError(error)
    return { ok: false, error: { ...safe, details: error instanceof PortLogError ? error.details : {} } }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new PortLogError('VALIDATION', '请求体不能超过 2 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createPortLogHttpHandler(deps: RouterDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return async (request, response) => {
    if (!isAllowedRequest(request)) {
      writeJson(response, 403, { error: { code: 'VALIDATION', message: '请求来源不允许' } })
      return
    }
    const pathname = (request.url ?? '').split('?')[0]
    if (request.method === 'GET' && pathname === `${PREFIX}/events`) {
      deps.events.subscribe(response)
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: { code: 'VALIDATION', message: '仅支持 POST' } })
      return
    }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      writeJson(response, 415, { error: { code: 'VALIDATION', message: 'Content-Type 必须是 application/json' } })
      return
    }
    let rpcId = 'invalid'
    try {
      const body = JSON.parse(await readBody(request)) as { rpcId?: unknown; method?: unknown; payload?: unknown }
      if (typeof body.rpcId === 'string') rpcId = body.rpcId
      if (typeof body.method !== 'string') throw new PortLogError('VALIDATION', 'method 无效')
      if (body.payload === null || typeof (body.payload ?? {}) !== 'object' || Array.isArray(body.payload)) {
        throw new PortLogError('VALIDATION', 'payload 无效')
      }
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        const result = await dispatchPortLog(body.method, (body.payload ?? {}) as Payload, deps, controller.signal)
        if (!response.destroyed) writeJson(response, 200, { type: 'server-response', rpcId, result })
      } finally {
        response.off('close', abort)
      }
    } catch (error) {
      const safe = safeError(error)
      writeJson(response, error instanceof SyntaxError ? 400 : 200, {
        type: 'server-response', rpcId,
        result: { ok: false, error: { ...safe, details: {} } },
      })
    }
  }
}

export { PREFIX as PORT_LOG_ROUTE_PREFIX }

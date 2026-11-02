import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
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

/** /api 下 port-log RPC 的端点前缀（不含 `/api/`）。 */
export const PORT_LOG_ENDPOINT_PREFIX = 'port-log/'

/** port-log 控制面方法全集（每个方法注册一条 /api 下的精确 Fetch 路由）。 */
export const PORT_LOG_METHODS = [
  'appLogs.status', 'network.localAddresses', 'sessions.list',
  'mappings.list', 'mappings.create', 'mappings.update', 'mappings.remove',
  'mappings.importCsv', 'mappings.exportCsv', 'mappings.start', 'mappings.stop',
  'shares.list', 'shares.start', 'shares.stop',
  'sessionLogs.list', 'sessionLogs.defaultDirectory', 'sessionLogs.start', 'sessionLogs.update',
  'sessionLogs.stop', 'sessionLogs.pickDirectory', 'sessionLogs.listDir', 'sessionLogs.knownFolders',
] as const

/** SSE 流路由（保留非 /api 前缀，DSH Connection 仍会做认证）。 */
export const PORT_LOG_EVENTS_PATH = `${PREFIX}/events`

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

/** /api 通道的 port-log RPC handler：endpoint 形如 `port-log/mappings.list`。 */
export function createPortLogRpcHandler(deps: RouterDeps): (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcHandlerResult> {
  return async (endpoint, payload, signal) => {
    const method = endpoint.startsWith(PORT_LOG_ENDPOINT_PREFIX)
      ? endpoint.slice(PORT_LOG_ENDPOINT_PREFIX.length)
      : endpoint
    return dispatchPortLog(method, (payload ?? {}) as Payload, deps, signal)
  }
}

/** SSE 事件流（认证由调用方在挂载时经 Connection 完成）。 */
export function createPortLogEventsHandler(deps: RouterDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (_request, response) => {
    deps.events.subscribe(response)
  }
}

export { PREFIX as PORT_LOG_ROUTE_PREFIX }

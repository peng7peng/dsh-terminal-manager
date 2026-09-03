import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from './app-logger.ts'
import { exportMappingsCsv, parseMappingsCsv } from './csv.ts'
import { PortLogError, safeError } from './errors.ts'
import type { MappingStore } from './mapping-store.ts'
import { localAddresses } from './network.ts'
import type { RuntimeEventHub } from './sse.ts'
import type { PortMappingInput } from './types.ts'

const PREFIX = '/term-manager/ext/port-log'
const MAX_BODY_BYTES = 2 * 1024 * 1024

interface RouterDeps {
  store: MappingStore
  logger: AppLogger
  events: RuntimeEventHub
  ready: Promise<void>
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

export async function dispatchPortLog(endpoint: string, payload: Payload, deps: RouterDeps): Promise<RpcResult> {
  try {
    await deps.ready
    switch (endpoint) {
      case 'appLogs.status':
        return ok(await deps.logger.status())
      case 'network.localAddresses':
        return ok(localAddresses())
      case 'mappings.list':
        return ok(deps.store.list())
      case 'mappings.create': {
        const created = await deps.store.create(payload as unknown as PortMappingInput)
        deps.events.publish({ type: 'mapping-status', data: created })
        await deps.logger.log('info', 'mapping.created', { id: created.id, protocol: created.protocol, localAddr: created.localAddr, localPort: created.localPort })
        return ok(created)
      }
      case 'mappings.update': {
        const id = requireString(payload, 'id')
        const patch = payload.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new PortLogError('VALIDATION', 'patch 无效')
        const updated = await deps.store.update(id, patch as Partial<PortMappingInput>)
        deps.events.publish({ type: 'mapping-status', data: updated })
        await deps.logger.log('info', 'mapping.updated', { id })
        return ok(updated)
      }
      case 'mappings.remove': {
        const id = requireString(payload, 'id')
        await deps.store.remove(id)
        deps.events.publish({ type: 'mapping-removed', data: { id } })
        await deps.logger.log('info', 'mapping.removed', { id })
        return ok({ id })
      }
      case 'mappings.importCsv': {
        const csv = requireString(payload, 'csv')
        const created = await deps.store.merge(parseMappingsCsv(csv))
        for (const item of created) deps.events.publish({ type: 'mapping-status', data: item })
        await deps.logger.log('info', 'mapping.csv_imported', { count: created.length })
        return ok({ count: created.length, mappings: created })
      }
      case 'mappings.exportCsv':
        return ok({ csv: exportMappingsCsv(deps.store.list()) })
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
      const result = await dispatchPortLog(body.method, (body.payload ?? {}) as Payload, deps)
      writeJson(response, 200, { type: 'server-response', rpcId, result })
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

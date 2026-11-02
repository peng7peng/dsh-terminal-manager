import type { Context } from '@deepseek-ai/cordis'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { PortLogToolApi } from '../index.ts'
import type { TmEventBus } from '../../types/events.ts'
import type { SessionManagerApi } from '../../types/session-api.ts'
import { join } from 'node:path'
import { AppLogger } from './app-logger.ts'
import { MappingStore } from './mapping-store.ts'
import { MappingManager } from './mapping-manager.ts'
import { createPortLogEventsHandler, createPortLogRpcHandler, PORT_LOG_ENDPOINT_PREFIX, PORT_LOG_EVENTS_PATH, PORT_LOG_METHODS } from './router.ts'
import { RuntimeEventHub } from './sse.ts'
import { ShareManager } from './share-manager.ts'
import { SessionLogManager } from './session-log-manager.ts'
import { createDirectoryPicker, type DirectoryPickerService } from './directory-picker.ts'
import { exportMappingsCsv, parseMappingsCsv } from './csv.ts'
import { resolveKnownFolders } from './known-folders.ts'
import type { PortMappingInput, SessionLogOptions, ShareConfig } from './types.ts'

export interface PortLogExtensionDeps {
  sessions: SessionManagerApi
  events: TmEventBus
  dataDir: string
}

/**
 * 端口映射、会话共享与日志扩展的 host 入口。
 *
 * E0 仅建立可确定卸载的生命周期边界；后续能力都在本目录内装配。
 */
export function registerPortLogExtension(ctx: Context, deps: PortLogExtensionDeps): PortLogToolApi | undefined {
  if (typeof ctx.effect !== 'function' || typeof ctx.get !== 'function') return undefined
  const root = join(deps.dataDir, 'ext', 'port-log')
  const logger = new AppLogger(join(root, 'log'))
  const store = new MappingStore(join(root, 'mappings.json'))
  const events = new RuntimeEventHub()
  const mappings = new MappingManager(store, logger, events)
  const shares = new ShareManager(deps.sessions, deps.events, logger, events)
  const sessionLogs = new SessionLogManager(join(root, 'session_logs'), deps.sessions, deps.events, logger, events)
  const lifetime = new AbortController()
  const pickDirectory = createDirectoryPicker(() => ctx.get('directoryPicker') as DirectoryPickerService | undefined)
  const unsubscribeMetadata = deps.events.on((event) => {
    if (event.type === 'status') {
      void logger.log('info', 'session.status', { sessionId: event.sessionId, status: event.status, protocol: event.snapshot.protocol })
    } else if (event.type === 'file') {
      void logger.log(event.ok ? 'info' : 'warn', 'session.file', {
        sessionId: event.sessionId, operation: event.op, ok: event.ok, bytes: event.bytes,
      })
    }
  }, { type: ['status', 'file'] })
  const ready = mappings.initialize()
    .then(() => logger.log('info', 'extension.started'))
    .then(() => mappings.autoStart())

  const api: PortLogToolApi = {
    ready,
    mappings: {
      list: () => mappings.list(),
      async create(input) { await ready; return mappings.create(input as unknown as PortMappingInput) },
      async update(id, patch) { await ready; return mappings.update(id, patch as unknown as Partial<PortMappingInput>) },
      async remove(id) { await ready; await mappings.remove(id) },
      async start(id) { await ready; return mappings.start(id) },
      async stop(id) { await ready; return mappings.stop(id) },
      async importCsv(csv) { await ready; return mappings.merge(parseMappingsCsv(csv)) },
      exportCsv: () => exportMappingsCsv(mappings.list()),
    },
    shares: {
      list: () => shares.list(),
      async start(input) {
        await ready
        if (deps.events === undefined) throw new Error('会话服务尚未就绪')
        return shares.start({
          sessionId: String(input.sessionId ?? ''),
          localAddr: typeof input.localAddr === 'string' ? input.localAddr : '0.0.0.0',
          sharePort: Number(input.sharePort ?? 2323),
          maxClients: Number(input.maxClients ?? 0),
          welcomeMessage: typeof input.welcomeMessage === 'string' ? input.welcomeMessage : '',
        } satisfies ShareConfig)
      },
      async stop(sessionId) { await ready; await shares.stop(sessionId) },
    },
    sessionLogs: {
      list: () => sessionLogs.list(),
      async start(sessionId, options, directory) {
        await ready
        return sessionLogs.start(sessionId, {
          timestamp: options.timestamp === true,
          stripAnsi: options.stripAnsi !== false,
        } satisfies SessionLogOptions, directory)
      },
      async update(sessionId, options) {
        await ready
        return sessionLogs.update(sessionId, {
          timestamp: options.timestamp === true,
          stripAnsi: options.stripAnsi !== false,
        } satisfies SessionLogOptions)
      },
      async stop(sessionId) { await ready; await sessionLogs.stop(sessionId) },
      getDefaultDirectory: () => sessionLogs.getDefaultDirectory(),
      async listDir(rawPath) {
        const raw = rawPath?.trim() ?? ''
        const dir = raw === '' ? sessionLogs.getDefaultDirectory() : resolve(raw)
        const entries = await readdir(dir, { withFileTypes: true })
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        const isRoot = sep === '/' ? dir === '/' : /^[A-Za-z]:[\\/]?$/.test(dir)
        return { path: dir, parent: isRoot ? null : resolve(dir, '..'), dirs }
      },
      knownFolders: () => resolveKnownFolders(),
    },
  }

  ctx.effect(
    () => {
      const webServer = ctx.get('webServer')
      const connection = ctx.get('connection')
      const routerDeps = {
        store, mappings, shares, sessions: deps.sessions, sessionLogs, logger, events, ready,
        pickDirectory: (signal: AbortSignal) => pickDirectory(AbortSignal.any([signal, lifetime.signal])),
      }
      // RPC 走 /api 下的精确 Fetch 路由（POST /api/port-log/<method>）；认证由 Connection 负责
      const rpcHandler = createPortLogRpcHandler(routerDeps)
      const routeDisposers: Array<() => Promise<void>> = []
      for (const method of PORT_LOG_METHODS) {
        const disposer = connection?.fetch?.register({
          path: `/api/${PORT_LOG_ENDPOINT_PREFIX}${method}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request: Request) => {
            let rpcId = 'invalid'
            let payload: unknown = {}
            try {
              const body = await request.json() as { rpcId?: unknown; payload?: unknown }
              if (typeof body.rpcId === 'string') rpcId = body.rpcId
              payload = body.payload ?? {}
            } catch {
              return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'VALIDATION', message: '请求体不是 JSON', details: {} } } }, { status: 400 })
            }
            const result = await rpcHandler(method, payload, request.signal)
            return Response.json({ type: 'server-response', rpcId, result })
          },
        })
        if (disposer !== undefined) routeDisposers.push(disposer)
      }
      // SSE 保留非 /api 前缀的 stream 例外；认证仍由 Connection 负责
      const eventsHandler = createPortLogEventsHandler(routerDeps)
      const unregister = webServer?.register({
        kind: 'exact' as const,
        path: PORT_LOG_EVENTS_PATH,
        handler: (request, response) => {
          const admission = connection?.admit(request)
          if (admission === undefined || 'rejection' in admission) {
            const status = admission !== undefined && 'rejection' in admission ? admission.rejection : 401
            response.writeHead(status)
            response.end()
            return
          }
          eventsHandler(request, response)
        },
      }) ?? (() => undefined)
      return async () => {
        lifetime.abort()
        unregister()
        await Promise.all(routeDisposers.map(dispose => dispose()))
        events.close()
        unsubscribeMetadata()
        await ready.catch(() => undefined)
        await shares.stopAll()
        await sessionLogs.closeAll()
        await mappings.stopAll()
        await logger.log('info', 'extension.stopped')
        await logger.close()
      }
    },
    'terminal-manager: port-log extension',
  )
  return api
}

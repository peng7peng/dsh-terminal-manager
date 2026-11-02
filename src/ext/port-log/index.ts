import type { Context } from '@deepseek-ai/cordis'
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
export function registerPortLogExtension(ctx: Context, deps: PortLogExtensionDeps): void {
  if (typeof ctx.effect !== 'function' || typeof ctx.get !== 'function') return
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
}

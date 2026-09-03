import type { Context } from '@deepseek-ai/cordis'
import type { TmEventBus } from '../../types/events.ts'
import type { SessionManagerApi } from '../../types/session-api.ts'
import { join } from 'node:path'
import { AppLogger } from './app-logger.ts'
import { MappingStore } from './mapping-store.ts'
import { MappingManager } from './mapping-manager.ts'
import { createPortLogHttpHandler, PORT_LOG_ROUTE_PREFIX } from './router.ts'
import { RuntimeEventHub } from './sse.ts'
import { ShareManager } from './share-manager.ts'

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
  if (typeof ctx.effect !== 'function') return
  const root = join(deps.dataDir, 'ext', 'port-log')
  const logger = new AppLogger(join(root, 'log'))
  const store = new MappingStore(join(root, 'mappings.json'))
  const events = new RuntimeEventHub()
  const mappings = new MappingManager(store, logger, events)
  const shares = new ShareManager(deps.sessions, deps.events, logger, events)
  const ready = mappings.initialize()
    .then(() => logger.log('info', 'extension.started'))
    .then(() => mappings.autoStart())

  ctx.effect(
    () => {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      const unregister = webServer?.register({
        kind: 'prefix' as const,
        path: PORT_LOG_ROUTE_PREFIX,
        handler: createPortLogHttpHandler({ store, mappings, shares, sessions: deps.sessions, logger, events, ready }),
      }) ?? (() => undefined)
      return async () => {
        unregister()
        events.close()
        await ready.catch(() => undefined)
        await shares.stopAll()
        await mappings.stopAll()
        await logger.log('info', 'extension.stopped')
        await logger.close()
      }
    },
    'terminal-manager: port-log extension',
  )
}

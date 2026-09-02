/**
 * B9 事件总线 —— `src/types/events.ts` 契约的实现。
 * 同步派发；订阅者抛错被吞掉（打 console.error），保证终端主链路不受扩展模块影响。
 * @module dsh-terminal-manager/event-bus
 */

import type { TmEvent, TmEventBus, TmEventFilter, TmEventHandler } from './types/events.ts'

interface Subscription {
  handler: TmEventHandler
  filter: TmEventFilter | undefined
}

function matches(filter: TmEventFilter | undefined, event: TmEvent): boolean {
  if (filter === undefined) return true
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false
  if (filter.type !== undefined) {
    const types = typeof filter.type === 'string' ? [filter.type] : filter.type
    if (!types.includes(event.type)) return false
  }
  return true
}

/** 新建一条事件总线。 */
export function createEventBus(): TmEventBus {
  const subs = new Set<Subscription>()
  return {
    emit(event) {
      for (const sub of [...subs]) {
        if (!matches(sub.filter, event)) continue
        try {
          sub.handler(event)
        } catch (error) {
          console.error('[terminal-manager] 事件订阅者抛错（已忽略）:', error)
        }
      }
    },
    on(handler, filter) {
      const sub: Subscription = { handler, filter }
      subs.add(sub)
      return () => { subs.delete(sub) }
    },
  }
}

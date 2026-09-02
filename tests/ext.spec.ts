import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createEventBus } from '../src/event-bus.ts'
import { registerExtensions } from '../src/ext/index.ts'
import { SessionManager } from '../src/session-manager.ts'

describe('扩展模块挂载点', () => {
  it('空壳可用：接受契约依赖，不注册任何东西、不抛错', () => {
    const sessions = new SessionManager(undefined)
    const ctx = {} as unknown as Context
    expect(() => registerExtensions(ctx, { sessions, events: createEventBus(), dataDir: 'D:/tmp/tm' })).not.toThrow()
  })
})

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from '@deepseek-ai/cordis'
import { registerPortLogClient } from '../client/ext/port-log/index.tsx'
import { createEventBus } from '../src/event-bus.ts'
import { registerPortLogExtension } from '../src/ext/port-log/index.ts'
import { SessionManager } from '../src/session-manager.ts'

describe('port-log 扩展空壳', () => {
  it('host 只注册一次生命周期，并在卸载时只清理一次', async () => {
    let dispose: (() => Promise<void>) | undefined
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const effect = vi.fn((setup: () => () => Promise<void>) => {
      dispose = setup()
    })
    const ctx = { effect, get: vi.fn(() => ({ register })) } as unknown as Context
    const dataDir = await mkdtemp(join(tmpdir(), 'tm-index-'))

    registerPortLogExtension(ctx, {
      sessions: new SessionManager(undefined),
      events: createEventBus(),
      dataDir,
    })

    expect(effect).toHaveBeenCalledOnce()
    expect(dispose).toBeTypeOf('function')
    await dispose?.()
    expect(register).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('client 各注册一次侧边栏与 overlay 空槽位', () => {
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((_name: string, setup: () => unknown) => setup())
    const ctx = { slots: { inject, register } } as unknown as ClientContext

    registerPortLogClient(ctx)

    expect(inject).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register.mock.calls.map(([slot]) => slot.id)).toEqual([
      'term-manager-port-log-entry',
      'term-manager-port-log-workspace',
    ])
  })
})

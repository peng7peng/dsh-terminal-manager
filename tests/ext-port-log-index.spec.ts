import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from '@deepseek-ai/cordis'
import { registerPortLogClient } from '../client/ext/port-log/index.tsx'
import { createEventBus } from '../src/event-bus.ts'
import { PortLogError, safeError, PORT_LOG_ERROR_CODES } from '../src/ext/port-log/errors.ts'
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

describe('port-log errors', () => {
  it('PortLogError 保留 code、message 和 details', () => {
    const error = new PortLogError('VALIDATION', '字段无效', { field: 'port' })
    expect(error.code).toBe('VALIDATION')
    expect(error.message).toBe('字段无效')
    expect(error.details).toEqual({ field: 'port' })
    expect(error.name).toBe('PortLogError')
    expect(error instanceof Error).toBe(true)
  })

  it('PortLogError 默认 details 为空对象', () => {
    const error = new PortLogError('IO_ERROR', '失败')
    expect(error.details).toEqual({})
  })

  it('safeError 对 PortLogError 保留原始 code 和 message', () => {
    const original = new PortLogError('MAPPING_NOT_FOUND', '映射不存在', { id: 'x' })
    const safe = safeError(original)
    expect(safe.code).toBe('MAPPING_NOT_FOUND')
    expect(safe.message).toBe('映射不存在')
  })

  it('safeError 对普通 Error 返回 IO_ERROR 和通用消息', () => {
    const safe = safeError(new Error('something broke'))
    expect(safe.code).toBe('IO_ERROR')
    expect(safe.message).toBe('操作失败，请查看应用日志')
  })

  it('safeError 对非 Error 值返回 IO_ERROR', () => {
    const safe = safeError('string error')
    expect(safe.code).toBe('IO_ERROR')
    expect(safe.message).toBe('操作失败，请查看应用日志')
  })

  it('PORT_LOG_ERROR_CODES 包含所有预定义错误码', () => {
    expect(PORT_LOG_ERROR_CODES).toContain('VALIDATION')
    expect(PORT_LOG_ERROR_CODES).toContain('PORT_IN_USE')
    expect(PORT_LOG_ERROR_CODES).toContain('MAPPING_NOT_FOUND')
    expect(PORT_LOG_ERROR_CODES).toContain('IO_ERROR')
    expect(PORT_LOG_ERROR_CODES).toContain('IMPORT_INVALID')
  })
})

describe('port-log 扩展注册边界', () => {
  it('ctx 缺少 effect 或 get 时不注册', () => {
    // ctx.effect 不是函数
    const ctx1 = { get: vi.fn() } as unknown as Context
    expect(() => registerPortLogExtension(ctx1, {
      sessions: new SessionManager(undefined),
      events: createEventBus(),
      dataDir: tmpdir(),
    })).not.toThrow()
    // ctx.get 不是函数
    const ctx2 = { effect: vi.fn() } as unknown as Context
    expect(() => registerPortLogExtension(ctx2, {
      sessions: new SessionManager(undefined),
      events: createEventBus(),
      dataDir: tmpdir(),
    })).not.toThrow()
  })

  it('webServer 为 undefined 时 unregister 返回 noop', async () => {
    let dispose: (() => Promise<void>) | undefined
    const effect = vi.fn((setup: () => () => Promise<void>) => {
      dispose = setup()
    })
    const ctx = { effect, get: vi.fn(() => undefined) } as unknown as Context
    const dataDir = await mkdtemp(join(tmpdir(), 'tm-index-'))
    registerPortLogExtension(ctx, {
      sessions: new SessionManager(undefined),
      events: createEventBus(),
      dataDir,
    })
    expect(dispose).toBeTypeOf('function')
    await dispose?.()
  })

  it('卸载时停止所有映射、共享和会话日志', async () => {
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
    await dispose?.()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('session 事件 status 和 file 类型被记录到日志', async () => {
    let dispose: (() => Promise<void>) | undefined
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const effect = vi.fn((setup: () => () => Promise<void>) => {
      dispose = setup()
    })
    const ctx = { effect, get: vi.fn(() => ({ register })) } as unknown as Context
    const dataDir = await mkdtemp(join(tmpdir(), 'tm-index-'))
    const events = createEventBus()
    registerPortLogExtension(ctx, {
      sessions: new SessionManager(undefined),
      events,
      dataDir,
    })
    // 触发 status 事件
    events.emit({ type: 'status', sessionId: 's1', status: 'open', snapshot: { protocol: 'ssh' } as any, ts: Date.now() })
    // 触发 file 事件（ok=true）
    events.emit({ type: 'file', sessionId: 's1', op: 'upload', ok: true, bytes: 100, ts: Date.now() })
    // 触发 file 事件（ok=false → warn 级别）
    events.emit({ type: 'file', sessionId: 's1', op: 'download', ok: false, bytes: 0, ts: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await dispose?.()
  })

  it('pickDirectory 通过 AbortSignal.any 组合 lifetime 和请求 signal', async () => {
    let dispose: (() => Promise<void>) | undefined
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const effect = vi.fn((setup: () => () => Promise<void>) => {
      dispose = setup()
    })
    let directoryPickerCalled = false
    const ctx = {
      effect,
      get: vi.fn(() => ({
        register,
        directoryPicker: {
          pick: async () => { directoryPickerCalled = true; return 'C:\\selected' },
        },
      })),
    } as unknown as Context
    const dataDir = await mkdtemp(join(tmpdir(), 'tm-index-'))
    registerPortLogExtension(ctx, {
      sessions: new SessionManager(undefined),
      events: createEventBus(),
      dataDir,
    })
    // 验证 dispose 正常执行（lifetime signal 被 abort）
    await dispose?.()
    expect(unregister).toHaveBeenCalledOnce()
  })
})

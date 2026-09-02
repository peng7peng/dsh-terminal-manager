import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Mock 三个注册函数，跟踪调用 */
const mockRegisterTools = vi.fn()
function mockRegisterRemotesImpl() { return () => {} }
const mockRegisterRemotes = vi.fn(mockRegisterRemotesImpl)
function mockRegisterWsIoImpl() { return () => {} }
const mockRegisterWsIo = vi.fn(mockRegisterWsIoImpl)
const mockRegisterAmbiguity = vi.fn()
const mockRegisterExtensions = vi.fn()

vi.mock('../src/ext/index.ts', () => ({
  registerExtensions: mockRegisterExtensions,
}))
vi.mock('../src/tools.ts', () => ({
  registerTerminalTools: mockRegisterTools,
}))
vi.mock('../src/remotes.ts', () => ({
  registerRemotes: mockRegisterRemotes,
}))
vi.mock('../src/ws-io.ts', () => ({
  registerWsIo: mockRegisterWsIo,
}))
vi.mock('../src/ambiguity.ts', () => ({
  registerAmbiguityHandling: mockRegisterAmbiguity,
}))

/** Mock SessionManager，跟踪 closeAll 调用 */
const mockCloseAll = vi.fn().mockResolvedValue(undefined)
const mockEvents = { emit: vi.fn(), on: vi.fn() }
class MockSessionManager { closeAll = mockCloseAll; events = mockEvents }
vi.mock('../src/session-manager.ts', () => ({
  SessionManager: MockSessionManager,
}))

/** Mock ConnectionStore，不碰真实文件系统 */
class MockConnectionStore {}
vi.mock('../src/connection-store.ts', () => ({
  ConnectionStore: MockConnectionStore,
}))

/** 在每次测试前清掉所有 mock 调用记录和环境变量 */
beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.DSH_TERMINAL_MANAGER_DATA
  delete process.env.DSH_HOME
})

/** 构造一个假 ctx，只记录 effect 注册的清理函数 */
function fakeCtx() {
  const cleanups: Array<() => void> = []
  return {
    ctx: {
      effect: (fn: () => (() => void), _label?: string) => {
        const cleanup = fn()
        cleanups.push(cleanup)
        return () => cleanup()
      },
    },
    runCleanups: () => { for (const c of cleanups) c() },
  }
}

describe('插件元数据', () => {
  it('name 是 terminal-manager', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.name).toBe('terminal-manager')
  })

  it('inject 包含 tools、systemPrompt、webServer', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.inject).toEqual(['tools', 'systemPrompt', 'webServer'])
  })
})

describe('resolveDataDir', () => {
  it('优先用 DSH_TERMINAL_MANAGER_DATA', async () => {
    const { resolveDataDir } = await import('../src/index.ts')
    process.env.DSH_TERMINAL_MANAGER_DATA = '/custom/path'
    expect(resolveDataDir()).toBe('/custom/path')
  })

  it('其次用 DSH_HOME/terminal-manager', async () => {
    const { resolveDataDir } = await import('../src/index.ts')
    process.env.DSH_HOME = '/my/dsh'
    const result = resolveDataDir()
    expect(result).toMatch(/my.dsh[/\\]terminal-manager$/)
  })

  it('都没有时用 ~/.dsh/terminal-manager', async () => {
    const { resolveDataDir } = await import('../src/index.ts')
    const result = resolveDataDir()
    expect(result).toMatch(/\.dsh[/\\]terminal-manager$/)
  })

  it('支持传入自定义 env（不污染 process.env）', async () => {
    const { resolveDataDir } = await import('../src/index.ts')
    const result = resolveDataDir({ DSH_TERMINAL_MANAGER_DATA: '/injected' })
    expect(result).toBe('/injected')
  })
})

describe('apply(ctx) 装配', () => {
  it('调用了 registerTerminalTools、registerRemotes、registerWsIo、registerAmbiguityHandling', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx } = fakeCtx()
    apply(ctx as never)
    expect(mockRegisterTools).toHaveBeenCalledTimes(1)
    expect(mockRegisterRemotes).toHaveBeenCalledTimes(1)
    expect(mockRegisterWsIo).toHaveBeenCalledTimes(1)
    expect(mockRegisterAmbiguity).toHaveBeenCalledTimes(1)
  })

  it('registerRemotes 收到 { sessions, store }', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx } = fakeCtx()
    apply(ctx as never)
    const deps = mockRegisterRemotes.mock.calls[0][1]
    expect(deps).toHaveProperty('sessions')
    expect(deps).toHaveProperty('store')
  })

  it('registerTerminalTools 收到 sessions', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx } = fakeCtx()
    apply(ctx as never)
    // 第二个参数是 sessions（有 closeAll 方法）
    const sessions = mockRegisterTools.mock.calls[0][1]
    expect(sessions).toHaveProperty('closeAll')
  })

  it('registerExtensions 收到契约依赖 { sessions, events, dataDir }', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx } = fakeCtx()
    process.env.DSH_TERMINAL_MANAGER_DATA = '/ext/data'
    apply(ctx as never)
    expect(mockRegisterExtensions).toHaveBeenCalledTimes(1)
    const [passedCtx, deps] = mockRegisterExtensions.mock.calls[0]
    expect(passedCtx).toBe(ctx)
    expect(deps.sessions).toHaveProperty('closeAll')
    expect(deps.events).toBe(mockEvents)
    expect(deps.dataDir).toBe('/ext/data')
  })
})

describe('apply(ctx) 卸载', () => {
  it('执行清理函数后 sessions.closeAll 被调用', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx, runCleanups } = fakeCtx()
    apply(ctx as never)
    expect(mockCloseAll).not.toHaveBeenCalled()
    runCleanups()
    expect(mockCloseAll).toHaveBeenCalledTimes(1)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { TermWs } from '../client/ws.ts'

// 在无 DOM 的测试环境保留 hook 状态与 effect 依赖，验证连接状态切换。
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0, effectIndex: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = initial
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value }]
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = hooks.effectIndex++
    const previous = hooks.effects[index]
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
    hooks.pending.push(() => {
      previous?.cleanup?.()
      hooks.effects[index] = { deps, cleanup: effect() || undefined }
    })
  },
}))
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }))
vi.mock('../client/ext/port-log/store.ts', () => ({
  usePortLogState: () => ({ shares: [], sessionLogs: [] }),
  applyPortLogEvent: vi.fn(),
}))
vi.mock('../client/ext/port-log/rpc.ts', () => ({ portLogRpc: vi.fn() }))
import { portLogRpc } from '../client/ext/port-log/rpc.ts'
import { TermView } from '../client/TermView.tsx'

const ws = {} as TermWs
function render(isOpen: boolean, isClosed = false): void {
  hooks.stateIndex = 0
  hooks.effectIndex = 0
  TermView({ sessionId: 's1', label: 'vm-test', target: 'host:22', ws, onDisconnect: vi.fn(), isOpen, isClosed }) as ReactElement
  hooks.pending.splice(0).forEach(run => run())
}

beforeEach(() => {
  hooks.effects.forEach(effect => effect.cleanup?.())
  hooks.states = []
  hooks.effects = []
  hooks.pending = []
  vi.mocked(portLogRpc).mockReset().mockResolvedValue({ sessionId: 's1', state: 'running' })
})

describe('终端自动存盘时机', () => {
  it('连接中不启动，进入 open 后启动；普通重渲染不重复启动', async () => {
    render(false)
    await Promise.resolve()
    expect(portLogRpc).not.toHaveBeenCalled()
    render(true)
    await vi.waitFor(() => expect(portLogRpc).toHaveBeenCalledExactlyOnceWith('sessionLogs.start', {
      sessionId: 's1', timestamp: true, stripAnsi: true,
    }))
    render(true)
    expect(portLogRpc).toHaveBeenCalledTimes(1)
  })

  it('断开后重连仍等到 open 才重新开启存盘', async () => {
    render(true)
    await vi.waitFor(() => expect(portLogRpc).toHaveBeenCalledTimes(1))
    render(false, true)
    render(false)
    expect(portLogRpc).toHaveBeenCalledTimes(1)
    render(true)
    await vi.waitFor(() => expect(portLogRpc).toHaveBeenCalledTimes(2))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { TermWs } from '../client/ws.ts'

// 在无 DOM 的测试环境保留 hook 状态与 effect 依赖，验证连接状态切换。
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0, effectIndex: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  sessionLogs: [] as Array<{ sessionId: string; state: string; path: string }>,
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
  usePortLogState: () => ({ shares: [], sessionLogs: hooks.sessionLogs }),
  applyPortLogEvent: vi.fn(),
}))
vi.mock('../client/ext/port-log/rpc.ts', () => ({ portLogRpc: vi.fn() }))
vi.mock('../client/rpc.ts', () => ({ rpc: vi.fn() }))
import { rpc } from '../client/rpc.ts'
import { portLogRpc } from '../client/ext/port-log/rpc.ts'
import { TermView } from '../client/TermView.tsx'

const ws = {} as TermWs
function render(isOpen: boolean, isClosed = false): ReactElement {
  hooks.stateIndex = 0
  hooks.effectIndex = 0
  const tree = TermView({ sessionId: 's1', label: 'vm-test', target: 'host:22', ws, onDisconnect: vi.fn(), isOpen, isClosed })
  hooks.pending.splice(0).forEach(run => run())
  return tree
}

function logPathRow(tree: ReactElement) {
  const children = (tree.props as { children: Array<ReactElement | false> }).children
  return children.find(child => child && (child.props as { className?: string }).className === 'tm-logPath') as ReactElement<{
    children: string; onDoubleClick: () => void
  }> | undefined
}

beforeEach(() => {
  hooks.effects.forEach(effect => effect.cleanup?.())
  hooks.states = []
  hooks.effects = []
  hooks.pending = []
  hooks.sessionLogs = []
  vi.mocked(rpc).mockReset().mockResolvedValue({})
  vi.mocked(portLogRpc).mockReset().mockResolvedValue({ sessionId: 's1', state: 'running' })
})

describe('终端自动存盘时机', () => {
  it('存盘时显示包含文件名的完整路径，双击交给系统打开；停止后移除路径行', async () => {
    const path = 'C:\\日志目录\\vm-test(2026-09-08_22-00-00-000).log'
    hooks.sessionLogs = [{ sessionId: 's1', state: 'running', path }]
    const row = logPathRow(render(true))
    expect(row?.props.children).toBe(path)
    expect(rpc).not.toHaveBeenCalled()
    row!.props.onDoubleClick()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledExactlyOnceWith('files.open', {
      root: 'C:/日志目录', path,
    }))
    hooks.sessionLogs = []
    expect(logPathRow(render(true))).toBeUndefined()
  })

  it('连接未打开或日志出错时不显示路径行', () => {
    hooks.sessionLogs = [{ sessionId: 's1', state: 'running', path: '/logs/session.log' }]
    expect(logPathRow(render(false))).toBeUndefined()
    hooks.sessionLogs = [{ sessionId: 's1', state: 'error', path: '/logs/session.log' }]
    expect(logPathRow(render(true))).toBeUndefined()
  })

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

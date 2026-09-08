import { afterEach, describe, expect, it, vi } from 'vitest'
import { portLogRpc, subscribePortLogEvents } from '../client/ext/port-log/rpc.ts'
import { subscribeShares } from '../client/ext/port-log/share-sync.ts'
import { getPortLogState, setShares, type ClientShare } from '../client/ext/port-log/store.ts'

vi.mock('../client/ext/port-log/rpc.ts', () => ({ portLogRpc: vi.fn(), subscribePortLogEvents: vi.fn() }))
const share = (count: number): ClientShare => ({
  sessionId: 's1', localAddr: '0.0.0.0', sharePort: 2323, maxClients: 0, welcomeMessage: '', state: 'running',
  clients: Array.from({ length: count }, (_, i) => ({ id: String(i), remoteAddress: '127.0.0.1', connectedAtMs: 0, bytesToClient: 0, bytesFromClient: 0 })),
})
let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.resetAllMocks(); setShares([]) })

function setup() {
  vi.useFakeTimers()
  let event!: (type: string, data: unknown) => void
  let open!: () => void
  const unsubscribe = vi.fn()
  vi.mocked(subscribePortLogEvents).mockImplementation((onEvent, onOpen) => { event = onEvent; open = onOpen; return unsubscribe })
  const errors = vi.fn()
  cleanup = subscribeShares(errors)
  return { event, open, unsubscribe, errors }
}

describe('共享客户端数量同步', () => {
  it('重新打开窗口读取已连接客户端，实时连接和断开立即更新', async () => {
    setShares([share(0)])
    vi.mocked(portLogRpc).mockResolvedValue([share(1)])
    const { event } = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(getPortLogState().shares[0].clients).toHaveLength(1)
    event('share-status', share(2))
    expect(getPortLogState().shares[0].clients).toHaveLength(2)
    event('share-status', share(0))
    expect(getPortLogState().shares[0].clients).toHaveLength(0)
  })

  it('重连和定时校准补回漏收事件，已停止共享从列表移除', async () => {
    vi.mocked(portLogRpc).mockResolvedValueOnce([share(0)]).mockResolvedValueOnce([share(1)]).mockResolvedValueOnce([])
    const { open } = setup()
    await vi.advanceTimersByTimeAsync(0)
    open()
    await vi.advanceTimersByTimeAsync(0)
    expect(getPortLogState().shares[0].clients).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getPortLogState().shares).toEqual([])
  })

  it('旧快照不会把实时客户端数量覆盖回 0，关闭时清理订阅和轮询', async () => {
    let resolve!: (value: ClientShare[]) => void
    vi.mocked(portLogRpc).mockReturnValue(new Promise(r => { resolve = r }))
    const { event, unsubscribe } = setup()
    event('share-status', share(1))
    resolve([share(0)])
    await vi.advanceTimersByTimeAsync(0)
    expect(getPortLogState().shares[0].clients).toHaveLength(1)
    cleanup?.(); cleanup = undefined
    await vi.advanceTimersByTimeAsync(9000)
    expect(portLogRpc).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.mocked(portLogRpc).mock.calls[0][2]?.aborted).toBe(true)
  })
})

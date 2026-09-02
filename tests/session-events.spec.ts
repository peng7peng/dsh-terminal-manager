/**
 * B4 会话管理器 → B9 事件总线的埋点：output / input（含来源）/ status。
 * 用假传输，不碰真实设备。
 */
import { describe, expect, it } from 'vitest'
import { createEventBus } from '../src/event-bus.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { Transport, TransportCallbacks } from '../src/transport/types.ts'
import type { TmEvent } from '../src/types/events.ts'

function fakeFactory(): { written: string[]; slots: TransportCallbacks[]; factory: TransportFactory } {
  const written: string[] = []
  const slots: TransportCallbacks[] = []
  const factory: TransportFactory = async (_target, callbacks) => {
    slots.push(callbacks)
    const transport: Transport = {
      write: (data) => { written.push(data) },
      close: async () => { callbacks.onClose('本端主动断开') },
    }
    return transport
  }
  return { written, slots, factory }
}

const target = { protocol: 'telnet' as const, host: '127.0.0.1', port: 2323, label: 'dut' }

describe('会话事件埋点', () => {
  it('connect 派发 connecting → open 两个 status 事件，snapshot 带名称与协议', async () => {
    const { factory } = fakeFactory()
    const bus = createEventBus()
    const seen: TmEvent[] = []
    bus.on(e => seen.push(e), { type: 'status' })
    const sm = new SessionManager(undefined, factory, bus)
    const snap = await sm.connect(target)
    const statuses = seen.map(e => e.type === 'status' ? e.status : '')
    expect(statuses).toEqual(['connecting', 'open'])
    const last = seen[1]
    expect(last?.type === 'status' && last.snapshot).toMatchObject({ sessionId: snap.sessionId, label: 'dut', protocol: 'telnet' })
    expect(sm.events).toBe(bus)
  })

  it('未注入总线时自建一条，效果相同', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: TmEvent[] = []
    sm.events.on(e => seen.push(e))
    await sm.connect(target)
    expect(seen.filter(e => e.type === 'status')).toHaveLength(2)
  })

  it('设备输出派发 output 事件，数据与订阅者收到的一致', async () => {
    const { slots, factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: TmEvent[] = []
    sm.events.on(e => seen.push(e), { type: 'output' })
    const snap = await sm.connect(target)
    slots[0]?.onData('router> ')
    expect(seen).toEqual([{ type: 'output', sessionId: snap.sessionId, data: 'router> ', ts: expect.any(Number) }])
  })

  it('write 派发 source=human 的 input（原始按键）', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: TmEvent[] = []
    sm.events.on(e => seen.push(e), { type: 'input' })
    const snap = await sm.connect(target)
    sm.write(snap.sessionId, 'l')
    expect(seen).toEqual([{ type: 'input', sessionId: snap.sessionId, data: 'l', source: 'human', ts: expect.any(Number) }])
  })

  it('sendImmediate：带 guard = ai；不带 = human；显式 source 优先；data 不含换行', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: TmEvent[] = []
    sm.events.on(e => seen.push(e), { type: 'input' })
    const snap = await sm.connect(target)
    await sm.sendImmediate(snap.sessionId, 'show ver', { guard: {} })
    await sm.sendImmediate(snap.sessionId, 'show ver')
    await sm.sendImmediate(snap.sessionId, 'show ver', { source: 'script' })
    expect(seen.map(e => e.type === 'input' ? e.source : '')).toEqual(['ai', 'human', 'script'])
    expect(seen.every(e => e.type === 'input' && e.data === 'show ver')).toBe(true)
  })

  it('sendAndWait 在写入时派发 input；broadcast 缺省 source=broadcast，带 guard 则为 ai', async () => {
    const { slots, factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: TmEvent[] = []
    sm.events.on(e => seen.push(e), { type: 'input' })
    const snap = await sm.connect(target)

    const p1 = sm.sendAndWait(snap.sessionId, 'a', { wait: { quietMs: 100 } })
    slots[0]?.onData('a\r\nrouter> ')
    await p1
    const p2 = sm.broadcast('b', [snap.sessionId], { wait: { quietMs: 100 } })
    slots[0]?.onData('b\r\nrouter> ')
    await p2
    const p3 = sm.broadcast('c', [snap.sessionId], { wait: { quietMs: 100 }, guard: {} })
    slots[0]?.onData('c\r\nrouter> ')
    await p3

    expect(seen.map(e => e.type === 'input' ? `${e.data}:${e.source}` : '')).toEqual(['a:human', 'b:broadcast', 'c:ai'])
  })

  it('被动断开派发 status=closed；主动 disconnect 派发 status=removed', async () => {
    const { slots, factory } = fakeFactory()
    const sm = new SessionManager(undefined, factory)
    const seen: string[] = []
    sm.events.on(e => { if (e.type === 'status') seen.push(e.status) })
    const snap = await sm.connect(target)
    slots[0]?.onClose('设备断开')
    await sm.disconnect(snap.sessionId)
    expect(seen).toEqual(['connecting', 'open', 'closed', 'removed'])
  })
})

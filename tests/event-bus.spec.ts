import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../src/event-bus.ts'
import type { TmEvent } from '../src/types/events.ts'

const out = (sessionId: string, data = 'x'): TmEvent => ({ type: 'output', sessionId, data, ts: 1 })
const inp = (sessionId: string): TmEvent => ({ type: 'input', sessionId, data: 'ls', source: 'human', ts: 1 })

describe('B9 事件总线', () => {
  it('无过滤时收到全部事件；取消订阅后不再收到', () => {
    const bus = createEventBus()
    const seen: TmEvent[] = []
    const off = bus.on(e => seen.push(e))
    bus.emit(out('a'))
    bus.emit(inp('b'))
    expect(seen.map(e => e.type)).toEqual(['output', 'input'])
    off()
    bus.emit(out('c'))
    expect(seen).toHaveLength(2)
  })

  it('按 type 过滤（单个 / 数组）', () => {
    const bus = createEventBus()
    const single: TmEvent[] = []
    const multi: TmEvent[] = []
    bus.on(e => single.push(e), { type: 'input' })
    bus.on(e => multi.push(e), { type: ['input', 'status'] })
    bus.emit(out('a'))
    bus.emit(inp('a'))
    bus.emit({ type: 'status', sessionId: 'a', status: 'open', ts: 1, snapshot: { sessionId: 'a', label: 'a', target: 'h:1', protocol: 'ssh', status: 'open' } })
    expect(single.map(e => e.type)).toEqual(['input'])
    expect(multi.map(e => e.type)).toEqual(['input', 'status'])
  })

  it('按 sessionId 过滤；file 事件无 sessionId 时不匹配指定会话', () => {
    const bus = createEventBus()
    const seen: TmEvent[] = []
    bus.on(e => seen.push(e), { sessionId: 'a' })
    bus.emit(out('a'))
    bus.emit(out('b'))
    bus.emit({ type: 'file', op: 'upload', path: '/x', ok: true, ts: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe('a')
  })

  it('订阅者抛错被吞掉，不影响派发方和其他订阅者', () => {
    const bus = createEventBus()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    bus.on(() => { throw new Error('boom') })
    bus.on(later)
    expect(() => bus.emit(out('a'))).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it('派发过程中取消订阅是安全的', () => {
    const bus = createEventBus()
    const second = vi.fn()
    const off = bus.on(() => { off2() })
    const off2 = bus.on(second)
    bus.emit(out('a'))
    // 第一次派发时快照已含 second，所以它仍被调用一次；之后不再收到
    expect(second).toHaveBeenCalledTimes(1)
    bus.emit(out('a'))
    expect(second).toHaveBeenCalledTimes(1)
    off()
  })
})

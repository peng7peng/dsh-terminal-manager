import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'

function response(writeResult = true): ServerResponse & EventEmitter {
  const value = new EventEmitter() as ServerResponse & EventEmitter
  value.writeHead = vi.fn() as any
  value.write = vi.fn(() => writeResult) as any
  value.end = vi.fn() as any
  return value
}

describe('port-log SSE', () => {
  it('订阅、发布和断线清理', () => {
    const hub = new RuntimeEventHub()
    const client = response()
    hub.subscribe(client)
    expect(hub.clientCount).toBe(1)
    hub.publish({ type: 'mapping-status', data: { id: 'm1' } })
    expect(client.write).toHaveBeenCalledWith(expect.stringContaining('event: mapping-status'))
    client.emit('close')
    expect(hub.clientCount).toBe(0)
  })

  it('慢客户端不影响其他客户端，close 幂等', () => {
    const hub = new RuntimeEventHub()
    const slow = response(false)
    const fast = response(true)
    hub.subscribe(slow)
    hub.subscribe(fast)
    hub.publish({ type: 'app-log-status', data: {} })
    expect(slow.end).toHaveBeenCalledOnce()
    expect(fast.write).toHaveBeenCalledWith(expect.stringContaining('app-log-status'))
    expect(hub.clientCount).toBe(1)
    hub.close()
    hub.close()
    expect(fast.end).toHaveBeenCalledOnce()
  })
})

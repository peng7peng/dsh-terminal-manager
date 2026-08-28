import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TermWs } from '../client/ws.ts'

/**
 * 假 WebSocket 构造器
 * 模拟 WebSocket 行为，允许测试代码触发事件和检查发送的消息
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: Error) => void) | null = null

  sent: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = 3 // CLOSED
    this.onclose?.()
  }

  // 测试辅助方法：模拟连接成功
  simulateOpen() {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }

  // 测试辅助方法：模拟收到消息
  simulateMessage(data: string) {
    this.onmessage?.({ data })
  }

  // 测试辅助方法：模拟连接关闭
  simulateClose() {
    this.readyState = 3 // CLOSED
    this.onclose?.()
  }
}

describe('TermWs', () => {
  let termWs: TermWs

  beforeEach(() => {
    FakeWebSocket.instances = []
    termWs = new TermWs({
      url: 'ws://test',
      webSocketCtor: FakeWebSocket as any,
      reconnectBaseMs: 10, // 加快重连测试
    })
  })

  afterEach(() => {
    termWs.dispose()
  })

  it('open() 后状态变成 connecting，假 WebSocket onopen 触发后变成 open', () => {
    termWs.open()

    // 应该创建了一个 WebSocket 实例
    expect(FakeWebSocket.instances.length).toBe(1)
    const ws = FakeWebSocket.instances[0]

    // 模拟连接成功
    ws.simulateOpen()

    // 现在应该可以发送消息了
    termWs.input('session1', 'test command')
    expect(ws.sent.length).toBe(1)
    const frame = JSON.parse(ws.sent[0])
    expect(frame.kind).toBe('input')
    expect(frame.sessionId).toBe('session1')
    expect(frame.data).toBe('test command')
  })

  it('假 WebSocket onclose 触发后 → 自动重连（setTimeout 被调度）', async () => {
    vi.useFakeTimers()

    termWs.open()
    const ws1 = FakeWebSocket.instances[0]
    ws1.simulateOpen()

    // 模拟连接关闭
    ws1.simulateClose()

    // 应该调度了重连
    await vi.advanceTimersByTimeAsync(100)

    // 应该创建了新的 WebSocket 实例
    expect(FakeWebSocket.instances.length).toBe(2)

    vi.useRealTimers()
  })

  it('dispose() 后不再重连', async () => {
    vi.useFakeTimers()

    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    // 销毁
    termWs.dispose()

    // 模拟连接关闭
    ws.simulateClose()

    // 等待一段时间
    await vi.advanceTimersByTimeAsync(100)

    // 不应该创建新的 WebSocket 实例
    expect(FakeWebSocket.instances.length).toBe(1)

    vi.useRealTimers()
  })

  it('onOutput 订阅 → 假 WebSocket send 收到 attach 帧', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const handler = vi.fn()
    termWs.onOutput('session1', handler)

    // 应该发送了 attach 帧
    expect(ws.sent.length).toBe(1)
    const frame = JSON.parse(ws.sent[0])
    expect(frame.kind).toBe('attach')
    expect(frame.sessionId).toBe('session1')
  })

  it('取消订阅 → send 收到 detach 帧', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const handler = vi.fn()
    const unsubscribe = termWs.onOutput('session1', handler)

    // 取消订阅
    unsubscribe()

    // 应该发送了 detach 帧
    expect(ws.sent.length).toBe(2)
    const frame = JSON.parse(ws.sent[1])
    expect(frame.kind).toBe('detach')
    expect(frame.sessionId).toBe('session1')
  })

  it('input() → send 收到 input 帧', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    termWs.input('session1', 'test command')

    expect(ws.sent.length).toBe(1)
    const frame = JSON.parse(ws.sent[0])
    expect(frame.kind).toBe('input')
    expect(frame.sessionId).toBe('session1')
    expect(frame.data).toBe('test command')
  })

  it('resize() → send 收到 resize 帧', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    termWs.resize('session1', 80, 24)

    expect(ws.sent.length).toBe(1)
    const frame = JSON.parse(ws.sent[0])
    expect(frame.kind).toBe('resize')
    expect(frame.sessionId).toBe('session1')
    expect(frame.cols).toBe(80)
    expect(frame.rows).toBe(24)
  })

  it('收到 output 帧 → 对应 handler 被调用', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const handler = vi.fn()
    termWs.onOutput('session1', handler)

    // 模拟收到 output 帧
    ws.simulateMessage(JSON.stringify({
      kind: 'output',
      sessionId: 'session1',
      data: 'test output',
    }))

    expect(handler).toHaveBeenCalledWith('test output')
  })

  it('收到 status 帧 → statusHandler 被调用', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const handler = vi.fn()
    termWs.onStatus(handler)

    // 模拟收到 status 帧
    ws.simulateMessage(JSON.stringify({
      kind: 'status',
      sessionId: 'session1',
      status: 'open',
      label: 'test',
      target: '127.0.0.1:23',
      protocol: 'telnet',
    }))

    expect(handler).toHaveBeenCalled()
    const receivedFrame = handler.mock.calls[0][0]
    expect(receivedFrame.kind).toBe('status')
    expect(receivedFrame.sessionId).toBe('session1')
    expect(receivedFrame.status).toBe('open')
  })

  it('收到非法 JSON → 不崩溃', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const handler = vi.fn()
    termWs.onOutput('session1', handler)

    // 模拟收到非法 JSON
    expect(() => {
      ws.simulateMessage('not valid json {{{')
    }).not.toThrow()

    // handler 不应该被调用
    expect(handler).not.toHaveBeenCalled()
  })

  it('连接未 open 时调 input → 不抛异常', () => {
    termWs.open()
    const ws = FakeWebSocket.instances[0]
    // 不调用 simulateOpen()，保持 CONNECTING 状态

    // 不应该抛异常
    expect(() => {
      termWs.input('session1', 'test')
    }).not.toThrow()

    // 但也不应该发送消息
    expect(ws.sent.length).toBe(0)
  })
})

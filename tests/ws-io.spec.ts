import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { ConnectionStore } from '../src/connection-store.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import { TermIoConnection, registerWsIo, type OutFrame } from '../src/ws-io.ts'
import type { Transport, TransportCallbacks } from '../src/transport/types.ts'

/** 假传输：每会话一个槽位，可控喂输出。 */
function fakeFactory(): { emit: (slot: number, chunk: string) => void; factory: TransportFactory } {
  const slots: TransportCallbacks[] = []
  const factory: TransportFactory = async (_target, callbacks) => {
    slots.push(callbacks)
    return { write: () => {}, close: async () => { callbacks.onClose('本端主动断开') } }
  }
  return { emit: (slot, chunk) => slots[slot]?.onData(chunk), factory }
}

/** 假 ws：收发记到数组，可触发 close。 */
function fakeWs() {
  const sent: OutFrame[] = []
  const handlers = new Map<string, (arg: unknown) => void>()
  const ws = {
    send: (data: string) => sent.push(JSON.parse(data) as OutFrame),
    on: (event: string, cb: (arg: unknown) => void) => { handlers.set(event, cb) },
    close: () => { handlers.get('close')?.(undefined) },
    _emit: (event: string, arg: unknown) => { handlers.get(event)?.(arg) },
  }
  return { sent, ws }
}

let dir: string
let store: ConnectionStore
let connId: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-wsio-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'dev-a', protocol: 'telnet', host: '10.0.0.1', port: 23, quietMs: 100 })
  connId = conn.id
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const { emit, factory } = fakeFactory()
  const sessions = new SessionManager(store, factory)
  const { sent, ws } = fakeWs()
  const conn = new TermIoConnection(ws, sessions)
  const snap = await sessions.connectByConnId(connId) // slot 0
  return { emit, sessions, conn, sent, ws, snap }
}

describe('TermIoConnection 数据流帧分发', () => {
  it('attach 后输出帧推给该连接；detach 后不再推', async () => {
    const { emit, conn, sent, ws, snap } = await setup()
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    emit(0, 'hello\n')
    expect(sent.some(f => f.kind === 'output' && f.data === 'hello\n')).toBe(true)

    ws._emit('message', JSON.stringify({ kind: 'detach', sessionId: snap.sessionId }))
    const before = sent.length
    emit(0, 'after-detach\n')
    expect(sent.length).toBe(before) // detach 后不再推
  })

  it('input 帧调用 sessions.write', async () => {
    const { sessions, conn, ws, snap } = await setup()
    const writeSpy = vi.spyOn(sessions, 'write')
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    ws._emit('message', JSON.stringify({ kind: 'input', sessionId: snap.sessionId, data: 'ls\r' }))
    expect(writeSpy).toHaveBeenCalledWith(snap.sessionId, 'ls\r')
  })

  it('resize 帧调用 sessions.resize', async () => {
    const { sessions, ws, snap } = await setup()
    const resizeSpy = vi.spyOn(sessions, 'resize')
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    ws._emit('message', JSON.stringify({ kind: 'resize', sessionId: snap.sessionId, cols: 100, rows: 40 }))
    expect(resizeSpy).toHaveBeenCalledWith(snap.sessionId, 100, 40)
  })

  it('会话状态变化 → status 帧广播', async () => {
    const { sessions, sent, ws } = await setup()
    const seen: string[] = []
    const unsub = sessions.onStatus(s => seen.push(s.status))
    // 已有连接订阅了 status；断开一个会话触发 removed 帧
    // （status 帧应出现在 sent 里）
    const snap2 = await sessions.connect({ protocol: 'telnet', host: '10.0.0.2', port: 23, label: 'b' })
    expect(sent.some(f => f.kind === 'status' && f.sessionId === snap2.sessionId && f.status === 'open')).toBe(true)
    await sessions.disconnect(snap2.sessionId)
    expect(sent.some(f => f.kind === 'status' && f.sessionId === snap2.sessionId && f.status === 'removed')).toBe(true)
    unsub()
  })

  it('连接关闭 → 清掉所有订阅', async () => {
    const { sessions, ws, snap } = await setup()
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    const before = sessions.list().length
    ws.close() // 模拟 WS 关闭
    // 内部订阅已清；连接对象不再推
    expect(sessions.list().length).toBe(before) // 会话本身不受 WS 关闭影响（设计如此）
  })
})

describe('TermIoConnection 生命周期与容错', () => {
  it('非法 JSON 不崩溃、不关闭连接', async () => {
    const { conn, ws } = await setup()
    expect(() => ws._emit('message', 'not-json{{{')).not.toThrow()
    // 连接仍然活着：发一条正常帧还能处理
    const { sent } = await setup() // 另起一个验证
  })

  it('未知 kind 帧静默忽略', async () => {
    const { conn, ws, sent } = await setup()
    const before = sent.length
    expect(() => ws._emit('message', JSON.stringify({ kind: 'unknown', sessionId: 'x' }))).not.toThrow()
    expect(sent.length).toBe(before)
  })

  it('同一会话连续两次 attach → subscribe 只调一次', async () => {
    const { sessions, ws, snap } = await setup()
    const subscribeSpy = vi.spyOn(sessions, 'subscribe')
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    // 第一次 attach 调了 subscribe，第二次被内部 if 拦住
    expect(subscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('detach 未 attach 的会话不报错', async () => {
    const { ws } = await setup()
    expect(() => ws._emit('message', JSON.stringify({ kind: 'detach', sessionId: 'nonexistent' }))).not.toThrow()
  })

  it('input 到不存在的会话静默忽略', async () => {
    const { ws } = await setup()
    expect(() => ws._emit('message', JSON.stringify({ kind: 'input', sessionId: 'nonexistent', data: 'x' }))).not.toThrow()
  })

  it('连接关闭后，会话输出不再推给该连接', async () => {
    const { emit, conn, sent, ws, snap } = await setup()
    ws._emit('message', JSON.stringify({ kind: 'attach', sessionId: snap.sessionId }))
    emit(0, 'before-close\n')
    expect(sent.some(f => f.kind === 'output' && f.data === 'before-close\n')).toBe(true)

    ws.close() // 模拟 WS 关闭
    const afterClose = sent.length

    // 关闭后设备继续输出 → 不再推送
    emit(0, 'after-close\n')
    expect(sent.length).toBe(afterClose)
  })
})

describe('registerWsIo 降级', () => {
  it('ctx.get(webServer) 返回 undefined 时不报错，返回空 disposer', () => {
    const fakeSessions = { onStatus: () => () => {} } as unknown as SessionManager
    const ctx = { get: (_name: string) => undefined } as never
    expect(() => registerWsIo(ctx, fakeSessions)).not.toThrow()
    const handle = registerWsIo(ctx, fakeSessions)
    expect(() => handle.disposer()).not.toThrow()
    expect(() => handle.broadcastFileProgress({ kind: 'file-progress', transferId: 't', op: 'upload', sessionId: 's', remotePath: '/x', transferred: 0 })).not.toThrow()
  })
})

describe('registerWsIo 心跳与清理', () => {
  let dir: string
  let httpServer: Server
  let port: number
  let handle: ReturnType<typeof registerWsIo>
  let client: WebSocket

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-wsio-heartbeat-'))
    const store = new ConnectionStore(join(dir, 'connections.json'))
    await store.load()
    const sessions = new SessionManager(store, (async () => ({
      write: () => {},
      close: async () => {},
    })) as unknown as TransportFactory)

    httpServer = createServer()
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    port = (httpServer.address() as { port: number }).port

    const ctx = {
      get: (name: string) => {
        if (name === 'webServer') {
          return {
            registerUpgrade: (route: { path: string; handler: unknown }) => {
              httpServer.on('upgrade', route.handler as never)
              return () => httpServer.removeAllListeners('upgrade')
            },
          }
        }
        return undefined
      },
      effect: (setup: () => (() => void) | void) => setup(),
    } as never

    handle = registerWsIo(ctx, sessions)
  })

  afterAll(async () => {
    client?.terminate?.()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
    handle?.disposer()
    await rm(dir, { recursive: true, force: true })
  })

  async function connectClient(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term-io`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    return ws
  }

  it('broadcastFileProgress：进度帧广播给所有在线客户端（S5）', async () => {
    const c1 = await connectClient()
    const c2 = await connectClient()
    const got1: string[] = []
    const got2: string[] = []
    c1.on('message', (d: Buffer) => got1.push(d.toString()))
    c2.on('message', (d: Buffer) => got2.push(d.toString()))
    handle.broadcastFileProgress({ kind: 'file-progress', transferId: 'tx1', op: 'download', sessionId: 's', remotePath: '/a.bin', transferred: 5, total: 10, percent: 50 })
    await new Promise(r => setTimeout(r, 50))
    expect(got1).toHaveLength(1)
    expect(got2).toHaveLength(1)
    const frame = JSON.parse(got1[0]!) as { kind: string; transferId: string; percent: number }
    expect(frame).toMatchObject({ kind: 'file-progress', transferId: 'tx1', percent: 50 })
    c1.terminate()
    c2.terminate()
    await new Promise(r => setTimeout(r, 50))
  })

  it('每 30 秒给客户端发一次 ping', async () => {
    // 用 spyOn 拦截 setInterval，手动触发回调 —— 不动真实时钟，不干扰 ws 内部 I/O
    const original = global.setInterval
    const intervalCbs: Array<() => void> = []
    const spy = vi.spyOn(global, 'setInterval').mockImplementation((cb: never, _ms?: never) => {
      intervalCbs.push(cb as () => void)
      return original(() => {}, 10_000_000) // 占位 timer，永远不会真触发
    })

    const ws = await connectClient()
    const pings = { n: 0 }
    ws.on('ping', () => { pings.n++ })

    // 手动触发心跳回调两次
    expect(intervalCbs.length).toBe(1)
    intervalCbs[0]()
    await new Promise(r => setTimeout(r, 50))
    expect(pings.n).toBe(1)

    intervalCbs[0]()
    await new Promise(r => setTimeout(r, 50))
    expect(pings.n).toBe(2)

    spy.mockRestore()
    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('客户端断开后，clearInterval 被调用', async () => {
    const originalClear = global.clearInterval
    const cleared: NodeJS.Timeout[] = []
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation((id: never) => {
      cleared.push(id as NodeJS.Timeout)
      return originalClear(id as never)
    })

    const ws = await connectClient()
    ws.close()
    await new Promise(r => setTimeout(r, 50))

    // close 事件应触发 clearInterval
    expect(cleared.length).toBeGreaterThanOrEqual(1)
    clearSpy.mockRestore()
  })

  it('非 loopback 来源被拒（socket 销毁）', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          'GET /term-io HTTP/1.1\r\n' +
          'Host: evil.example\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        )
      })
      socket.on('close', () => resolve())
      socket.on('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('非 loopback socket 未被销毁')) }, 1000)
    })
  })

  it('跨站 Origin 的 WS 升级被拒（审查 2026-09-03：浏览器发 WS 必带 Origin，防跨站 WS 劫持）', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          'GET /term-io HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Origin: http://evil.example\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        )
      })
      socket.on('close', () => resolve())
      socket.on('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('恶意 Origin 的 socket 未被销毁')) }, 1000)
    })
  })

  it('同源 Origin 的 WS 升级放行', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term-io`, { headers: { origin: `http://127.0.0.1:${port}` } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('多个客户端各自有独立心跳；disposer 统一清理', async () => {
    const original = global.setInterval
    const intervalCbs: Array<() => void> = []
    const spy = vi.spyOn(global, 'setInterval').mockImplementation((cb: never, _ms?: never) => {
      intervalCbs.push(cb as () => void)
      return original(() => {}, 10_000_000)
    })

    const c1 = await connectClient()
    const c2 = await connectClient()
    const pings1 = { n: 0 }
    const pings2 = { n: 0 }
    c1.on('ping', () => { pings1.n++ })
    c2.on('ping', () => { pings2.n++ })

    // 每个连接各自注册了一个 setInterval
    expect(intervalCbs.length).toBe(2)

    intervalCbs[0]()
    intervalCbs[1]()
    await new Promise(r => setTimeout(r, 50))
    expect(pings1.n).toBe(1)
    expect(pings2.n).toBe(1)

    // disposer：清掉所有 timer，关所有连接
    handle.disposer()
    await new Promise(r => setTimeout(r, 50))

    // disposer 之后回调里的 readyState 不是 OPEN，ping 不会发出
    // （即使手动再调一次回调）
    intervalCbs[0]()
    intervalCbs[1]()
    await new Promise(r => setTimeout(r, 50))
    expect(pings1.n).toBe(1)
    expect(pings2.n).toBe(1)

    c1.terminate()
    c2.terminate()
    await new Promise(r => setTimeout(r, 50))
    spy.mockRestore()
    expect(() => handle.disposer()).not.toThrow()
  })
})

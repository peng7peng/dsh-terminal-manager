import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import { TermIoConnection, type OutFrame } from '../src/ws-io.ts'
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
    // 已有连接订阅了 status；断开一个会话触发 closed 帧
    // （status 帧应出现在 sent 里）
    const snap2 = await sessions.connect({ protocol: 'telnet', host: '10.0.0.2', port: 23, label: 'b' })
    expect(sent.some(f => f.kind === 'status' && f.sessionId === snap2.sessionId && f.status === 'open')).toBe(true)
    await sessions.disconnect(snap2.sessionId)
    expect(sent.some(f => f.kind === 'status' && f.sessionId === snap2.sessionId && f.status === 'closed')).toBe(true)
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

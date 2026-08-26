import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { dispatch } from '../src/remotes.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
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

let dir: string
let store: ConnectionStore
let connId: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-remotes-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'dev-a', protocol: 'telnet', host: '10.0.0.1', port: 23, quietMs: 100 })
  connId = conn.id
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeDeps() {
  const { emit, factory } = fakeFactory()
  const sessions = new SessionManager(store, factory)
  return { emit, deps: { sessions, store } }
}

const abort = new AbortController().signal

describe('B7a 指令通道 dispatch', () => {
  it('connections.list 返回清单', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('connections.list', {}, deps, abort)
    expect(r.ok).toBe(true)
    expect((r as { value: { label: string }[] }).value.some(c => c.label === 'dev-a')).toBe(true)
  })

  it('connections.create / update / remove 全链路', async () => {
    const { deps } = makeDeps()
    const created = await dispatch('connections.create', { label: 'new', protocol: 'telnet', host: '1.2.3.4' }, deps, abort)
    expect(created.ok).toBe(true)
    const id = (created as { value: { id: string } }).value.id
    const updated = await dispatch('connections.update', { id, patch: { label: 'renamed' } }, deps, abort)
    expect((updated as { value: { label: string } }).value.label).toBe('renamed')
    const removed = await dispatch('connections.remove', { id }, deps, abort)
    expect(removed.ok).toBe(true)
  })

  it('connections.create 校验失败 → 错误分支带 VALIDATION', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('connections.create', { label: '', protocol: 'telnet', host: 'x' }, deps, abort)
    expect(r.ok).toBe(false)
    expect((r as { error: { message: string } }).error.message).toContain('VALIDATION')
  })

  it('sessions.connect / read / disconnect', async () => {
    const { emit, deps } = makeDeps()
    const connected = await dispatch('sessions.connect', { connId }, deps, abort)
    expect(connected.ok).toBe(true)
    const sid = (connected as { value: { sessionId: string } }).value.sessionId

    // 人工键入用 sessions.write；这里测 read 缓冲
    emit(0, 'hello\n')
    const read = await dispatch('sessions.read', { sessionId: sid }, deps, abort)
    expect((read as { value: { text: string } }).value.text).toContain('hello')

    const closed = await dispatch('sessions.disconnect', { sessionId: sid }, deps, abort)
    expect(closed.ok).toBe(true)
  })

  it('sessions.connect 不存在的 connId → 错误分支带 SESSION_NOT_FOUND', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('sessions.connect', { connId: 'nope' }, deps, abort)
    expect(r.ok).toBe(false)
    expect((r as { error: { message: string } }).error.message).toContain('SESSION_NOT_FOUND')
  })

  it('未知方法 → 错误分支', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('bogus.method', {}, deps, abort)
    expect(r.ok).toBe(false)
    expect((r as { error: { message: string } }).error.message).toContain('未知方法')
  })
})

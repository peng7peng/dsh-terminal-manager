/**
 * B7a /api 通道：RPC handler 的端点剥离、分发与错误折叠。
 * Host/Origin 栅栏与浏览器认证由 DSH Connection 统一负责（0.2.1 起插件不再自建 CORS/loopback 判断）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { createRpcHandler, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { TransportCallbacks } from '../src/transport/types.ts'

function fakeFactory(): TransportFactory {
  return async (_target, callbacks: TransportCallbacks) => ({
    write: () => {},
    close: async () => { callbacks.onClose('本端主动断开') },
  })
}

let dir: string
let store: ConnectionStore
let connId: string
let deps: RemoteDeps
let handler: ReturnType<typeof createRpcHandler>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-remotes-http-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'dev-a', protocol: 'telnet', host: '10.0.0.1', port: 23, quietMs: 100 })
  connId = conn.id
  const sessions = new SessionManager(store, fakeFactory())
  deps = { sessions, store }
  handler = createRpcHandler(deps)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const abort = new AbortController().signal
const peer = {} as never

describe('createRpcHandler /api 分发', () => {
  it('端点带 term-manager/ 前缀时剥离后分发（connections.list）', async () => {
    const result = await handler('term-manager/connections.list', {}, abort, peer)
    expect(result).toMatchObject({ ok: true, value: [{ label: 'dev-a' }] })
  })

  it('端点不带前缀时也按原样分发（兼容直接调用）', async () => {
    const result = await handler('connections.list', {}, abort, peer)
    expect(result).toMatchObject({ ok: true })
  })

  it('未知端点 → internal 错误（不泄露堆栈）', async () => {
    const result = await handler('term-manager/nope', {}, abort, peer)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect((result as { error: { message: string } }).error.message).toContain('未知方法')
  })

  it('payload 为 null 时按空对象处理（connections.list 可用）', async () => {
    const result = await handler('term-manager/connections.list', null, abort, peer)
    expect(result).toMatchObject({ ok: true })
  })

  it('signal 已取消 → cancelled 错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await handler('term-manager/connections.list', {}, controller.signal, peer)
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('连接不存在的 connId → SESSION_NOT_FOUND 折叠进 message', async () => {
    const result = await handler('term-manager/sessions.connect', { connId: 'nope' }, abort, peer)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect((result as { error: { message: string } }).error.message).toContain('SESSION_NOT_FOUND')
  })

  it('sessions.connect 用已保存连接建立会话', async () => {
    const result = await handler('term-manager/sessions.connect', { connId }, abort, peer)
    expect(result).toMatchObject({ ok: true, value: { connId, status: 'open' } })
    const sid = (result as { value: { sessionId: string } }).value.sessionId
    await handler('term-manager/sessions.disconnect', { sessionId: sid }, abort, peer)
  })
})

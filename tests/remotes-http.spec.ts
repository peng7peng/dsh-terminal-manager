import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { createHttpHandler, isTrustedOrigin, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { TransportCallbacks } from '../src/transport/types.ts'

/** 假传输 */
function fakeFactory(): TransportFactory {
  return async (_target, callbacks: TransportCallbacks) => ({
    write: () => {},
    close: async () => { callbacks.onClose('本端主动断开') },
  })
}

/** 构造假 req：带 method、url、body（自动 async-iterable） */
function fakeReq(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const chunks: Buffer[] = body ? [Buffer.from(body)] : []
  const readable = Readable.from(chunks)
  return Object.assign(readable, { method, url, headers: { host: '127.0.0.1:3180', ...headers } })
}

/** 构造假 res：记录 writeHead 和 end 的内容 */
function fakeRes() {
  const calls: { statusCode: number; headers: Record<string, string> }[] = []
  let ended = ''
  return {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      calls.push({ statusCode, headers: headers ?? {} })
    },
    end(data?: string) { ended = data ?? '' },
    _calls: calls,
    _body: () => ended,
    _json: () => JSON.parse(ended) as Record<string, unknown>,
  }
}

let dir: string
let store: ConnectionStore
let connId: string
let deps: RemoteDeps
let handler: ReturnType<typeof createHttpHandler>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-remotes-http-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'dev-a', protocol: 'telnet', host: '10.0.0.1', port: 23, quietMs: 100 })
  connId = conn.id
  const sessions = new SessionManager(store, fakeFactory())
  deps = { sessions, store }
  handler = createHttpHandler(deps)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 发请求并返回假 res */
async function request(method: string, url: string, body?: string, headers?: Record<string, string>) {
  const req = fakeReq(method, url, body, headers)
  const res = fakeRes()
  await handler(req as never, res as never)
  return res
}

describe('来源围栏 isTrustedOrigin', () => {
  it('无 Origin 放行；loopback 任意端口放行；与 Host 相同放行', () => {
    expect(isTrustedOrigin(undefined, '127.0.0.1:3180')).toBe(true)
    expect(isTrustedOrigin('', '127.0.0.1:3180')).toBe(true)
    expect(isTrustedOrigin('http://localhost:4580', '127.0.0.1:3180')).toBe(true)
    expect(isTrustedOrigin('http://127.0.0.1:9999', '127.0.0.1:3180')).toBe(true)
    expect(isTrustedOrigin('http://[::1]:3180', '127.0.0.1:3180')).toBe(true)
    expect(isTrustedOrigin('http://dev-box:3180', 'dev-box:3180')).toBe(true)
    expect(isTrustedOrigin('http://DEV-BOX:3180', 'dev-box:3180')).toBe(true)
  })
  it('互联网来源 / 其他主机 / 非法 Origin → 拒绝', () => {
    expect(isTrustedOrigin('https://evil.example', '127.0.0.1:3180')).toBe(false)
    expect(isTrustedOrigin('http://dev-box:3180', '127.0.0.1:3180')).toBe(false)
    expect(isTrustedOrigin('null', '127.0.0.1:3180')).toBe(false)
    expect(isTrustedOrigin('not a url', '127.0.0.1:3180')).toBe(false)
  })
})

describe('HTTP 路由 handler', () => {
  it('OPTIONS（同源，无 Origin）→ 204，不发 CORS 允许头', async () => {
    const res = await request('OPTIONS', '/term-manager/connections.list')
    expect(res._calls[0].statusCode).toBe(204)
    expect(res._calls[0].headers['access-control-allow-origin']).toBeUndefined()
    expect(res._calls[0].headers['access-control-allow-methods']).toContain('POST')
    expect(res._calls[0].headers['access-control-allow-headers']).toContain('content-type')
  })

  it('OPTIONS（本机 Origin）→ 204 + 回显该 Origin', async () => {
    const res = await request('OPTIONS', '/term-manager/connections.list', undefined, { origin: 'http://localhost:3180' })
    expect(res._calls[0].statusCode).toBe(204)
    expect(res._calls[0].headers['access-control-allow-origin']).toBe('http://localhost:3180')
    expect(res._calls[0].headers['vary']).toBe('Origin')
  })

  it('互联网来源的 OPTIONS / POST → 403，不处理请求（防 CSRF 打 files.write）', async () => {
    const pre = await request('OPTIONS', '/term-manager/files.write', undefined, { origin: 'https://evil.example' })
    expect(pre._calls[0].statusCode).toBe(403)
    expect(pre._calls[0].headers['access-control-allow-origin']).toBeUndefined()
    const body = JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'connections.list', payload: {} })
    const post = await request('POST', '/term-manager/connections.list', body, { origin: 'https://evil.example' })
    expect(post._calls[0].statusCode).toBe(403)
    expect(post._body()).toContain('forbidden origin')
  })

  it('GET → 405', async () => {
    const res = await request('GET', '/term-manager/connections.list')
    expect(res._calls[0].statusCode).toBe(405)
  })

  it('POST 非 JSON → 400 + bad-request', async () => {
    const res = await request('POST', '/term-manager/connections.list', 'not-json{{{')
    expect(res._calls[0].statusCode).toBe(400)
    const body = res._json()
    expect((body.result as { error: { code: string } }).error.code).toBe('bad-request')
  })

  it('POST 正常请求 → 200 + rpcId + result', async () => {
    const rpcId = 'test-rpc-123'
    const body = JSON.stringify({ type: 'client-request', rpcId, method: 'connections.list', payload: {} })
    const res = await request('POST', '/term-manager/connections.list', body)
    expect(res._calls[0].statusCode).toBe(200)
    const parsed = res._json()
    expect(parsed.rpcId).toBe(rpcId)
    expect((parsed.result as { ok: boolean }).ok).toBe(true)
  })

  it('URL 路径路由（body 无 method 时按 URL 分发）', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'url-test', payload: {} })
    const res = await request('POST', '/term-manager/connections.list', body)
    const parsed = res._json()
    expect((parsed.result as { ok: boolean }).ok).toBe(true)
  })

  it('连接存储校验失败 → result.ok=false + VALIDATION', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'val', method: 'connections.create',
      payload: { label: '', protocol: 'telnet', host: 'x' },
    })
    const res = await request('POST', '/term-manager/connections.create', body)
    const parsed = res._json()
    const result = parsed.result as { ok: boolean; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('VALIDATION')
  })

  it('会话不存在 → result.ok=false + SESSION_NOT_FOUND', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'nf', method: 'sessions.connect',
      payload: { connId: 'nonexistent-id' },
    })
    const res = await request('POST', '/term-manager/sessions.connect', body)
    const parsed = res._json()
    const result = parsed.result as { ok: boolean; error: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('SESSION_NOT_FOUND')
  })

  it('同源 POST（无 Origin）不发 CORS 头；带本机 Origin 的 POST 回显该 Origin，绝不回 *', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'cors', method: 'connections.list', payload: {} })
    const plain = await request('POST', '/term-manager/connections.list', body)
    expect(plain._calls[0].statusCode).toBe(200)
    expect(plain._calls[0].headers['access-control-allow-origin']).toBeUndefined()
    const local = await request('POST', '/term-manager/connections.list', body, { origin: 'http://127.0.0.1:3180' })
    expect(local._calls[0].statusCode).toBe(200)
    expect(local._calls[0].headers['access-control-allow-origin']).toBe('http://127.0.0.1:3180')
  })
})

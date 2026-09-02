import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerRemotes, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager } from '../src/session-manager.ts'
import { ConnectionStore } from '../src/connection-store.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface FakeRoute { kind: string; path: string; handler: (req: unknown, res: unknown) => void }

function fakeCtx(withWebServer: boolean) {
  const routes: FakeRoute[] = []
  const disposed: string[] = []
  const cleanups: Array<() => void> = []
  const webServer = {
    register: (route: FakeRoute) => { routes.push(route); return () => { disposed.push(route.path) } },
  }
  const ctx = {
    get: (name: string) => (name === 'webServer' && withWebServer ? webServer : undefined),
    effect: (fn: () => () => void) => { const c = fn(); cleanups.push(c); return c },
  } as unknown as Context
  return { ctx, routes, disposed, cleanups }
}

async function makeDeps(): Promise<RemoteDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-reg-'))
  const store = new ConnectionStore(join(dir, 'connections.json'))
  return { sessions: new SessionManager(store, async (_t, cb) => ({ write: () => {}, close: async () => { cb.onClose('x') } })), store }
}

describe('registerRemotes 挂载', () => {
  it('没有 webServer → 不挂载，返回空清理函数', async () => {
    const { ctx, routes } = fakeCtx(false)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const off = registerRemotes(ctx, await makeDeps())
    expect(routes).toHaveLength(0)
    expect(() => off()).not.toThrow()
    log.mockRestore()
  })

  it('有 webServer → 注册 /term-manager 前缀路由；handler 能处理请求；effect 清理时注销路由', async () => {
    const { ctx, routes, disposed, cleanups } = fakeCtx(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    registerRemotes(ctx, await makeDeps())
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/term-manager' })
    // 走一遍 handler：POST connections.list
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'connections.list', payload: {} })
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/term-manager/connections.list', headers: { host: '127.0.0.1:3180' } })
    let ended = ''
    const res = { writeHead: () => {}, end: (d?: string) => { ended = d ?? '' } }
    await new Promise<void>((resolve) => { routes[0]!.handler(req, res); setTimeout(resolve, 50) })
    expect(JSON.parse(ended)).toMatchObject({ rpcId: 'r1', result: { ok: true, value: [] } })
    for (const c of cleanups) c()
    expect(disposed).toEqual(['/term-manager'])
    log.mockRestore()
  })
})

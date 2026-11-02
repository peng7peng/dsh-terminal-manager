import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { registerRemotes, TERM_MANAGER_METHODS, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager } from '../src/session-manager.ts'
import { ConnectionStore } from '../src/connection-store.ts'

function fakeCtx(withConnection: boolean) {
  const fetchRoutes: ConnectionFetchRoute[] = []
  const connection = {
    fetch: {
      register: (route: ConnectionFetchRoute) => {
        fetchRoutes.push(route)
        return async () => undefined
      },
    },
  }
  const ctx = {
    get: (name: string) => (name === 'connection' && withConnection ? connection : undefined),
    effect: (fn: () => unknown) => fn(),
  } as unknown as Context
  return { ctx, fetchRoutes }
}

async function makeDeps(): Promise<RemoteDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-reg-'))
  const store = new ConnectionStore(join(dir, 'connections.json'))
  return { sessions: new SessionManager(store, async (_t, cb) => ({ write: () => {}, close: async () => { cb.onClose('x') } })), store }
}

describe('registerRemotes 挂载', () => {
  it('没有 connection → 不挂载，返回空清理函数', async () => {
    const { ctx, fetchRoutes } = fakeCtx(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const off = registerRemotes(ctx, await makeDeps())
    expect(fetchRoutes).toHaveLength(0)
    expect(() => off()).not.toThrow()
    warn.mockRestore()
  })

  it('有 connection → 每个控制面方法一条 /api 精确 Fetch 路由 + 上传/下载；handler 能分发', async () => {
    const { ctx, fetchRoutes } = fakeCtx(true)
    registerRemotes(ctx, await makeDeps())
    const paths = fetchRoutes.map(route => route.path)
    for (const method of TERM_MANAGER_METHODS) expect(paths).toContain(`/api/term-manager/${method}`)
    expect(fetchRoutes.every(route => route.methods.length === 1)).toBe(true)
    expect(fetchRoutes.find(route => route.path === '/api/term-manager/files/upload')).toMatchObject({ methods: ['POST'], requestBody: 'streaming' })
    expect(fetchRoutes.find(route => route.path === '/api/term-manager/files/download')).toMatchObject({ methods: ['GET'], requestBody: 'buffered' })

    const listRoute = fetchRoutes.find(route => route.path === '/api/term-manager/connections.list')!
    const response = await listRoute.fetch(new Request('http://localhost/api/term-manager/connections.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'connections.list', payload: {} }),
    }))
    expect(await response.json()).toMatchObject({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: [] } })

    const badRoute = fetchRoutes.find(route => route.path === '/api/term-manager/sessions.list')!
    const bad = await badRoute.fetch(new Request('http://localhost/api/term-manager/sessions.list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ rpcId: 'invalid', result: { ok: false } })
  })
})

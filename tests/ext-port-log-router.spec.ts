import { createServer } from 'node:http'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'
import { MappingStore } from '../src/ext/port-log/mapping-store.ts'
import { createPortLogHttpHandler } from '../src/ext/port-log/router.ts'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function fixture(pickDirectory?: (signal: AbortSignal) => Promise<string | null>): Promise<{ base: string; logger: AppLogger }> {
  const directory = await mkdtemp(join(tmpdir(), 'tm-router-'))
  const store = new MappingStore(join(directory, 'mappings.json'))
  const logger = new AppLogger(join(directory, 'log'))
  const events = new RuntimeEventHub()
  const ready = store.ensureLoaded()
  const server = createServer(createPortLogHttpHandler({ store, logger, events, ready, pickDirectory }))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return { base: `http://127.0.0.1:${address.port}`, logger }
}

async function rpc(base: string, method: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/term-manager/ext/port-log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }),
  })
}

describe('port-log 控制面', () => {
  it('系统目录选择返回选中路径或取消，跨站请求不能打开窗口', async () => {
    let calls = 0
    const { base, logger } = await fixture(async () => ++calls === 1 ? 'C:\\日志 目录' : null)
    expect((await rpc(base, 'sessionLogs.pickDirectory', {}, { origin: 'http://evil.example' })).status).toBe(403)
    expect(calls).toBe(0)
    const chosen = await (await rpc(base, 'sessionLogs.pickDirectory')).json()
    expect(chosen.result).toEqual({ ok: true, value: { directory: 'C:\\日志 目录' } })
    const canceled = await (await rpc(base, 'sessionLogs.pickDirectory')).json()
    expect(canceled.result).toEqual({ ok: true, value: { directory: null } })
    await logger.close()
  })

  it('断开浏览器请求会取消系统窗口', async () => {
    let opened!: () => void
    let closed!: () => void
    const opening = new Promise<void>(resolve => { opened = resolve })
    const closing = new Promise<void>(resolve => { closed = resolve })
    const { base, logger } = await fixture(signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { closed(); resolve(null) }, { once: true })
      opened()
    }))
    const controller = new AbortController()
    const request = fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sessionLogs.pickDirectory' }), signal: controller.signal,
    }).catch(() => undefined)
    await opening
    controller.abort()
    await request
    await closing
    await logger.close()
  })

  it('完成映射 CRUD、CSV 和统一响应封包', async () => {
    const { base, logger } = await fixture()
    const createdResponse = await rpc(base, 'mappings.create', {
      protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18080,
      redirectAddr: 'localhost', redirectPort: 22, autoStart: false,
    })
    const created = await createdResponse.json() as any
    expect(created.result.ok).toBe(true)
    const listed = await (await rpc(base, 'mappings.list')).json() as any
    expect(listed.result.value).toHaveLength(1)
    const exported = await (await rpc(base, 'mappings.exportCsv')).json() as any
    expect(exported.result.value.csv).toContain('protocol,localAddr')
    const removed = await (await rpc(base, 'mappings.remove', { id: created.result.value.id })).json() as any
    expect(removed.result).toMatchObject({ ok: true })
    await logger.close()
  })

  it('拒绝跨来源 Origin 和错误 Content-Type', async () => {
    const { base, logger } = await fixture()
    expect((await rpc(base, 'mappings.list', {}, { origin: 'http://evil.example' })).status).toBe(403)
    const response = await fetch(`${base}/term-manager/ext/port-log`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(415)
    await logger.close()
  })

  it('处理 OPTIONS 并限制 2 MiB 请求体', async () => {
    const { base, logger } = await fixture()
    expect((await fetch(`${base}/term-manager/ext/port-log`, { method: 'OPTIONS' })).status).toBe(204)
    const response = await rpc(base, 'mappings.importCsv', { csv: 'x'.repeat(2 * 1024 * 1024) })
    const body = await response.json() as any
    expect(body.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    await logger.close()
  })

  it('sessionLogs.knownFolders 返回本机快速访问与盘符概览', async () => {
    const { base, logger } = await fixture()
    const response = await rpc(base, 'sessionLogs.knownFolders')
    const body = await response.json() as any
    expect(body.result.ok).toBe(true)
    const value = body.result.value
    expect(value.home).toBeTypeOf('string')
    expect(Array.isArray(value.quick)).toBe(true)
    expect(Array.isArray(value.drives)).toBe(true)
    expect(value.drives.length).toBeGreaterThan(0)
    await logger.close()
  })

  it('sessionLogs.listDir 返回子目录，盘符根之上 parent 为 null', async () => {
    const { base, logger } = await fixture()
    const directory = await mkdtemp(join(tmpdir(), 'tm-listdir-'))
    await mkdir(join(directory, 'a'))
    await mkdir(join(directory, 'b'))
    const listed = await (await rpc(base, 'sessionLogs.listDir', { path: directory })).json() as any
    expect(listed.result.ok).toBe(true)
    expect(listed.result.value.dirs).toEqual(['a', 'b'])
    expect(listed.result.value.parent).toBeTruthy()
    // 文件系统根（Windows 盘符根 / POSIX /）之上是「此电脑」：parent 为 null，且本身也能列目录
    const root = process.platform === 'win32' ? `${directory[0]}:\\` : '/'
    const rootListed = await (await rpc(base, 'sessionLogs.listDir', { path: root })).json() as any
    expect(rootListed.result.ok).toBe(true)
    expect(rootListed.result.value.parent).toBeNull()
    await logger.close()
  })
})

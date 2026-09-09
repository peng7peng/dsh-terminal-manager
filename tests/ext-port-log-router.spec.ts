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

  it('未知方法返回 VALIDATION 错误且不抛异常到外层', async () => {
    const { base, logger } = await fixture()
    const body = await (await rpc(base, 'not.a.real.method')).json() as any
    expect(body.result).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: '未知方法' } })
    await logger.close()
  })

  it('mappings.update 缺少 id 字段时返回 VALIDATION 错误', async () => {
    const { base, logger } = await fixture()
    const noId = await (await rpc(base, 'mappings.update', { patch: { autoStart: true } })).json() as any
    expect(noId.result).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'id 无效' } })
    const badPatch = await (await rpc(base, 'mappings.update', { id: 'x', patch: null })).json() as any
    expect(badPatch.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const arrayPatch = await (await rpc(base, 'mappings.update', { id: 'x', patch: [] })).json() as any
    expect(arrayPatch.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    await logger.close()
  })

  it('mappings.remove 缺少 id、不存在的 id 各返回对应错误', async () => {
    const { base, logger } = await fixture()
    const missing = await (await rpc(base, 'mappings.remove', {})).json() as any
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'id 无效' } })
    const notFound = await (await rpc(base, 'mappings.remove', { id: 'nonexistent-id' })).json() as any
    expect(notFound.result).toMatchObject({ ok: false, error: { code: 'MAPPING_NOT_FOUND' } })
    await logger.close()
  })

  it('mappings.start/stop 在映射运行时未就绪时返回 MAPPING_STATE', async () => {
    const { base, logger } = await fixture()
    const startBody = await (await rpc(base, 'mappings.start', { id: 'any' })).json() as any
    expect(startBody.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const stopBody = await (await rpc(base, 'mappings.stop', { id: 'any' })).json() as any
    expect(stopBody.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    await logger.close()
  })

  it('sessions.list/shares.start/shares.stop 在服务未就绪时返回 MAPPING_STATE', async () => {
    const { base, logger } = await fixture()
    const sessionsList = await (await rpc(base, 'sessions.list')).json() as any
    expect(sessionsList.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const sharesStart = await (await rpc(base, 'shares.start', { sessionId: 's1', sharePort: 1234 })).json() as any
    expect(sharesStart.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const sharesStop = await (await rpc(base, 'shares.stop', { sessionId: 's1' })).json() as any
    expect(sharesStop.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    await logger.close()
  })

  it('sessionLogs.start/update/stop/pickDirectory 在服务未就绪时返回对应错误', async () => {
    const { base, logger } = await fixture()
    const startBody = await (await rpc(base, 'sessionLogs.start', { sessionId: 's1' })).json() as any
    expect(startBody.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const updateBody = await (await rpc(base, 'sessionLogs.update', { sessionId: 's1' })).json() as any
    expect(updateBody.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const stopBody = await (await rpc(base, 'sessionLogs.stop', { sessionId: 's1' })).json() as any
    expect(stopBody.result).toMatchObject({ ok: false, error: { code: 'MAPPING_STATE' } })
    const pickBody = await (await rpc(base, 'sessionLogs.pickDirectory')).json() as any
    expect(pickBody.result).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } })
    await logger.close()
  })

  it('shares.list/sessionLogs.list 在服务未就绪时降级返回空数组', async () => {
    const { base, logger } = await fixture()
    const sharesList = await (await rpc(base, 'shares.list')).json() as any
    expect(sharesList.result).toEqual({ ok: true, value: [] })
    const sessionLogsList = await (await rpc(base, 'sessionLogs.list')).json() as any
    expect(sessionLogsList.result).toEqual({ ok: true, value: [] })
    const defaultDir = await (await rpc(base, 'sessionLogs.defaultDirectory')).json() as any
    expect(defaultDir.result).toEqual({ ok: true, value: { directory: '' } })
    await logger.close()
  })

  it('sessionLogs.listDir 空路径使用主目录，无效路径返回 IO_ERROR', async () => {
    const { base, logger } = await fixture()
    const empty = await (await rpc(base, 'sessionLogs.listDir', { path: '' })).json() as any
    expect(empty.result.ok).toBe(true)
    expect(typeof empty.result.value.path).toBe('string')
    expect(Array.isArray(empty.result.value.dirs)).toBe(true)
    const whitespace = await (await rpc(base, 'sessionLogs.listDir', { path: '   ' })).json() as any
    expect(whitespace.result.ok).toBe(true)
    const invalid = await (await rpc(base, 'sessionLogs.listDir', { path: join(tmpdir(), `non-existent-${Date.now()}`) })).json() as any
    expect(invalid.result).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } })
    const noPath = await (await rpc(base, 'sessionLogs.listDir', {})).json() as any
    expect(noPath.result.ok).toBe(true)
    await logger.close()
  })

  it('mappings.importCsv 缺少 csv 字段返回 VALIDATION', async () => {
    const { base, logger } = await fixture()
    const body = await (await rpc(base, 'mappings.importCsv', {})).json() as any
    expect(body.result).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'csv 无效' } })
    await logger.close()
  })

  it('appLogs.status 和 network.localAddresses 正常返回', async () => {
    const { base, logger } = await fixture()
    const status = await (await rpc(base, 'appLogs.status')).json() as any
    expect(status.result.ok).toBe(true)
    expect(status.result.value).toHaveProperty('level')
    expect(status.result.value).toHaveProperty('directory')
    const addresses = await (await rpc(base, 'network.localAddresses')).json() as any
    expect(addresses.result.ok).toBe(true)
    expect(Array.isArray(addresses.result.value)).toBe(true)
    expect(addresses.result.value).toContain('0.0.0.0')
    await logger.close()
  })

  it('mappings.create 完成后 mappings.update 改 autoStart 并能导出', async () => {
    const { base, logger } = await fixture()
    const created = await (await rpc(base, 'mappings.create', {
      protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18081,
      redirectAddr: 'localhost', redirectPort: 22, autoStart: false,
    })).json() as any
    expect(created.result.ok).toBe(true)
    const updated = await (await rpc(base, 'mappings.update', {
      id: created.result.value.id, patch: { autoStart: true },
    })).json() as any
    expect(updated.result.ok).toBe(true)
    expect(updated.result.value.autoStart).toBe(true)
    const listed = await (await rpc(base, 'mappings.list')).json() as any
    expect(listed.result.value[0].autoStart).toBe(true)
    await logger.close()
  })

  it('GET /events 订阅 SSE 且收到事件帧', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log/events`, { method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const { value } = await reader!.read()
    expect(new TextDecoder().decode(value)).toContain(': connected')
    reader!.cancel()
    await logger.close()
  })

  it('非 POST/GET/OPTIONS 方法返回 405', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log`, { method: 'DELETE' })
    expect(response.status).toBe(405)
    const body = await response.json() as any
    expect(body.error.code).toBe('VALIDATION')
    await logger.close()
  })

  it('请求体非 JSON 返回 400', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json{',
    })
    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.result).toMatchObject({ ok: false })
    await logger.close()
  })

  it('method 非字符串和 payload 非对象返回 200+错误封包', async () => {
    const { base, logger } = await fixture()
    const noMethod = await (await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'r1', payload: {} }),
    })).json() as any
    expect(noMethod.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const arrayPayload = await (await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'r1', method: 'mappings.list', payload: [] }),
    })).json() as any
    expect(arrayPayload.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const nullPayload = await (await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'r1', method: 'mappings.list', payload: null }),
    })).json() as any
    expect(nullPayload.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    await logger.close()
  })

  it('rpcId 非字符串时回退为 invalid，响应仍包含 rpcId', async () => {
    const { base, logger } = await fixture()
    const body = await (await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 123, method: 'mappings.list' }),
    })).json() as any
    expect(body.rpcId).toBe('invalid')
    expect(body.result.ok).toBe(true)
    await logger.close()
  })

  it('带合法 Origin 且 host 匹配时允许请求', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'mappings.list', payload: {} }),
    })
    expect(response.status).toBe(200)
    await logger.close()
  })

  it('带不合法 Origin（host 不匹配）返回 403', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'mappings.list', payload: {} }),
    })
    expect(response.status).toBe(403)
    await logger.close()
  })

  it('带畸形 Origin 返回 403', async () => {
    const { base, logger } = await fixture()
    const response = await fetch(`${base}/term-manager/ext/port-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'not-a-url' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'mappings.list', payload: {} }),
    })
    expect(response.status).toBe(403)
    await logger.close()
  })
})

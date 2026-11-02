import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createEventBus } from '../src/event-bus.ts'
import { registerExtensions } from '../src/ext/index.ts'
import type { SessionManagerApi, SessionSnapshot } from '../src/types/session-api.ts'

let dir: string
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tm-tool-api-')) })
afterAll(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); await rm(dir, { recursive: true, force: true }) })

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

function fakeSessions(): SessionManagerApi {
  const snapshot: SessionSnapshot = { sessionId: 's1', label: 'dev', target: '127.0.0.1:23', protocol: 'telnet', status: 'open' }
  return {
    events: createEventBus(),
    list: () => [snapshot],
    get: (id: string) => id === 's1' ? snapshot : undefined,
    onStatus: () => () => {},
    connect: async () => snapshot,
    connectByConnId: async () => snapshot,
    disconnect: async () => {},
    reconnect: async () => snapshot,
    subscribe: () => () => {},
    read: () => ({ text: '', totalLines: 0, truncated: false }),
    write: () => {},
    sendImmediate: async () => {},
    sendAndWait: async () => ({ output: '', waitReason: 'quiet' as const, truncated: false }),
    broadcast: async () => [],
  }
}

describe('port-log 扩展工具 API', () => {
  it('映射 CRUD/启停/CSV 与共享、日志能力', async () => {
    const ctx = {
      effect: (fn: () => unknown) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => Promise<void>); return cleanup },
      get: () => undefined,
    } as unknown as Context
    const eventBus = createEventBus()
    const handle = registerExtensions(ctx, { sessions: fakeSessions(), events: eventBus, dataDir: dir })
    const api = handle.portLog
    expect(api).toBeDefined()
    if (api === undefined) return
    await api.ready

    const localPort = await freePort()
    const created = await api.mappings.create({ protocol: 'tcp', localAddr: '127.0.0.1', localPort, redirectAddr: '127.0.0.1', redirectPort: 9, autoStart: false }) as { id: string }
    expect(created.id).toBeTruthy()
    expect(api.mappings.list()).toHaveLength(1)
    await expect(api.mappings.start(created.id)).resolves.toMatchObject({ state: 'running' })
    await expect(api.mappings.stop(created.id)).resolves.toMatchObject({ state: 'stopped' })
    await expect(api.mappings.update(created.id, { autoStart: true })).resolves.toMatchObject({ autoStart: true })
    const csv = api.mappings.exportCsv()
    expect(csv).toContain('protocol')
    expect(csv).toContain(String(localPort))
    const importPort = localPort === 39999 ? 39998 : 39999
    await expect(api.mappings.importCsv(`protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart\ntcp,127.0.0.1,${importPort},127.0.0.1,9,false`)).resolves.toBeTruthy()
    await api.mappings.remove(created.id)
    const remaining = api.mappings.list() as Array<{ id: string }>
    for (const item of remaining) await api.mappings.remove(item.id)
    expect(api.mappings.list()).toHaveLength(0)

    const sharePort = await freePort()
    const started = await api.shares.start({ sessionId: 's1', sharePort, localAddr: '127.0.0.1', maxClients: 1, welcomeMessage: 'hi' }) as { state: string }
    expect(started.state).toBe('running')
    expect(api.shares.list()).toHaveLength(1)
    await api.shares.stop('s1')
    expect(api.shares.list()).toHaveLength(0)

    const logDir = join(dir, 'logs')
    const log = await api.sessionLogs.start('s1', { timestamp: false, stripAnsi: true }, logDir) as { state: string }
    expect(log.state).toBe('running')
    expect(api.sessionLogs.list()).toHaveLength(1)
    await expect(api.sessionLogs.update('s1', { timestamp: true, stripAnsi: false })).resolves.toMatchObject({ timestamp: true })
    await api.sessionLogs.stop('s1')
    expect(api.sessionLogs.getDefaultDirectory()).toBeTruthy()
    await expect(api.sessionLogs.listDir(logDir)).resolves.toMatchObject({ path: logDir })
    await expect(api.sessionLogs.knownFolders()).resolves.toMatchObject({ home: expect.any(String) })

    eventBus.emit({ type: 'status', sessionId: 's1', status: 'open', snapshot: { sessionId: 's1', label: 'dev', target: 'h:23', protocol: 'telnet', status: 'open' }, ts: Date.now() })
    eventBus.emit({ type: 'file', sessionId: 's1', op: 'upload', ok: false, bytes: 0, ts: Date.now() })
  })
})

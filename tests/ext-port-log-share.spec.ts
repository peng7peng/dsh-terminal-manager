import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../src/event-bus.ts'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'
import { ShareManager } from '../src/ext/port-log/share-manager.ts'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'
import type { SessionManagerApi, SessionSnapshot } from '../src/types/session-api.ts'
import { connectTcp, freeTcpPort } from './ext-port-log-helpers.ts'

const sockets: Socket[] = []
afterEach(() => { for (const socket of sockets.splice(0)) socket.destroy() })

async function fixture(): Promise<{
  manager: ShareManager
  events: ReturnType<typeof createEventBus>
  write: ReturnType<typeof vi.fn>
  snapshot: SessionSnapshot
  logger: AppLogger
}> {
  const events = createEventBus()
  const snapshot: SessionSnapshot = { sessionId: 'session-1', label: '设备', target: '127.0.0.1:23', protocol: 'telnet', status: 'open' }
  const write = vi.fn()
  const sessions = { events, get: () => snapshot, list: () => [snapshot], write } as unknown as SessionManagerApi
  const directory = await mkdtemp(join(tmpdir(), 'tm-share-'))
  const logger = new AppLogger(join(directory, 'log'))
  return { manager: new ShareManager(sessions, events, logger, new RuntimeEventHub()), events, write, snapshot, logger }
}

function waitForData(socket: Socket, predicate: (data: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let all = Buffer.alloc(0)
    const timeout = setTimeout(() => reject(new Error('timeout')), 1000)
    socket.on('data', (chunk) => {
      all = Buffer.concat([all, chunk])
      if (predicate(all)) {
        clearTimeout(timeout)
        resolve(all)
      }
    })
  })
}

describe('port-log 会话共享', () => {
  it('无认证连接、多客户端实时输出并将输入写入公开 API', async () => {
    const { manager, events, write, logger } = await fixture()
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: 'welcome' })
    const clients = await Promise.all([connectTcp(port), connectTcp(port)])
    sockets.push(...clients)
    await Promise.all(clients.map((client) => waitForData(client, (data) => data.includes('welcome'))))
    const outputs = clients.map((client) => waitForData(client, (data) => data.includes('device-output')))
    events.emit({ type: 'output', sessionId: 'session-1', data: 'device-output', ts: Date.now() })
    expect((await Promise.all(outputs)).every((data) => data.includes('device-output'))).toBe(true)
    clients[0]!.write('show\r\n')
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('session-1', 'show\r'))
    await manager.stopAll()
    await logger.close()
  })

  it('不回放历史，会话关闭时自动停止并释放端口', async () => {
    const { manager, events, snapshot, logger } = await fixture()
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 1, welcomeMessage: '' })
    events.emit({ type: 'output', sessionId: 'session-1', data: 'old-history', ts: Date.now() })
    const client = await connectTcp(port)
    sockets.push(client)
    let received = Buffer.alloc(0)
    client.on('data', (chunk) => { received = Buffer.concat([received, chunk]) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received.includes('old-history')).toBe(false)
    snapshot.status = 'closed'
    events.emit({ type: 'status', sessionId: 'session-1', status: 'closed', snapshot, ts: Date.now() })
    await vi.waitFor(() => expect(manager.list()).toEqual([]))
    await logger.close()
  })

  it('慢客户端超过背压上限时单独断开，停止保持幂等', async () => {
    const events = createEventBus()
    const snapshot: SessionSnapshot = { sessionId: 'session-1', label: '设备', target: 'target', protocol: 'ssh', status: 'open' }
    const sessions = { events, get: () => snapshot, list: () => [snapshot], write: vi.fn() } as unknown as SessionManagerApi
    const directory = await mkdtemp(join(tmpdir(), 'tm-share-'))
    const logger = new AppLogger(join(directory, 'log'))
    const manager = new ShareManager(sessions, events, logger, new RuntimeEventHub(), 64)
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' })
    const client = await connectTcp(port)
    sockets.push(client)
    await vi.waitFor(() => expect(manager.list()[0]?.clients).toHaveLength(1))
    events.emit({ type: 'output', sessionId: 'session-1', data: 'x'.repeat(2 * 1024 * 1024), ts: Date.now() })
    await vi.waitFor(() => expect(manager.list()[0]?.clients).toHaveLength(0))
    await manager.stop('session-1')
    await expect(manager.stop('session-1')).resolves.toBeUndefined()
    await logger.close()
  })
})

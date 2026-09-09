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

  it('重复共享同一会话抛出 SHARE_ALREADY_ACTIVE', async () => {
    const { manager, logger } = await fixture()
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' })
    await expect(manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'SHARE_ALREADY_ACTIVE' })
    await manager.stopAll()
    await logger.close()
  })

  it('共享未打开的会话抛出 VALIDATION', async () => {
    const events = createEventBus()
    const snapshot: SessionSnapshot = { sessionId: 'session-closed', label: '设备', target: 'target', protocol: 'ssh', status: 'closed' }
    const sessions = { events, get: () => snapshot, list: () => [snapshot], write: vi.fn() } as unknown as SessionManagerApi
    const directory = await mkdtemp(join(tmpdir(), 'tm-share-'))
    const logger = new AppLogger(join(directory, 'log'))
    const manager = new ShareManager(sessions, events, logger, new RuntimeEventHub())
    const port = await freeTcpPort()
    await expect(manager.start({ sessionId: 'session-closed', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await logger.close()
  })

  it('maxClients 超出范围抛出 VALIDATION', async () => {
    const { manager, logger } = await fixture()
    const port = await freeTcpPort()
    await expect(manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: -1, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 10001, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await logger.close()
  })

  it('欢迎语超过 512 字符抛出 VALIDATION', async () => {
    const { manager, logger } = await fixture()
    const port = await freeTcpPort()
    await expect(manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: 'x'.repeat(513) }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await logger.close()
  })

  it('端口被占用抛出 PORT_IN_USE', async () => {
    const { manager, logger } = await fixture()
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' })
    // 第二次用同端口但不同 sessionId（会话状态需为 open）
    const events = createEventBus()
    const snapshot2: SessionSnapshot = { sessionId: 'session-2', label: '设备2', target: 'target', protocol: 'ssh', status: 'open' }
    const sessions2 = { events, get: () => snapshot2, list: () => [snapshot2], write: vi.fn() } as unknown as SessionManagerApi
    const directory = await mkdtemp(join(tmpdir(), 'tm-share-'))
    const logger2 = new AppLogger(join(directory, 'log'))
    const manager2 = new ShareManager(sessions2, events, logger2, new RuntimeEventHub())
    await expect(manager2.start({ sessionId: 'session-2', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'PORT_IN_USE' })
    await manager.stopAll()
    await logger.close()
    await logger2.close()
  })

  it('stopAll 后新操作抛出 MAPPING_STATE', async () => {
    const { manager, logger } = await fixture()
    await manager.stopAll()
    const port = await freeTcpPort()
    await expect(manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 0, welcomeMessage: '' }))
      .rejects.toMatchObject({ code: 'MAPPING_STATE' })
    await logger.close()
  })

  it('maxClients 限制达到上限时新客户端被拒绝', async () => {
    const { manager, logger } = await fixture()
    const port = await freeTcpPort()
    await manager.start({ sessionId: 'session-1', localAddr: '127.0.0.1', sharePort: port, maxClients: 1, welcomeMessage: '' })
    const client1 = await connectTcp(port)
    sockets.push(client1)
    await vi.waitFor(() => expect(manager.list()[0]?.clients).toHaveLength(1))
    const client2 = await connectTcp(port)
    sockets.push(client2)
    // 第二个客户端应收到拒绝消息并被服务器 end
    const received = await new Promise<Buffer>((resolve) => {
      let all = Buffer.alloc(0)
      client2.on('data', (chunk) => {
        all = Buffer.concat([all, chunk])
        if (all.includes('上限')) resolve(all)
      })
      client2.on('close', () => resolve(all))
    })
    expect(received.toString()).toContain('上限')
    await manager.stopAll()
    await logger.close()
  })
})

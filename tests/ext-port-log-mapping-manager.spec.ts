import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'
import { MappingManager } from '../src/ext/port-log/mapping-manager.ts'
import { MappingStore } from '../src/ext/port-log/mapping-store.ts'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'
import { closeTcpServer, connectTcp, freeTcpPort, listenTcpEcho, readTcp } from './ext-port-log-helpers.ts'
import { closeUdp, freeUdpPort, listenUdpEcho, udpRoundTrip } from './ext-port-log-helpers.ts'
import { createSocket } from 'node:dgram'

async function createManager(): Promise<{ manager: MappingManager; logger: AppLogger }> {
  const directory = await mkdtemp(join(tmpdir(), 'tm-manager-'))
  const logger = new AppLogger(join(directory, 'log'))
  const manager = new MappingManager(new MappingStore(join(directory, 'mappings.json')), logger, new RuntimeEventHub())
  await manager.initialize()
  return { manager, logger }
}

describe('port-log 映射管理器', () => {
  it('串行启停并通过 TCP 控制面状态转发', async () => {
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await Promise.all([manager.start(created.id), manager.start(created.id)])
    expect(manager.list()[0]?.state).toBe('running')
    const client = await connectTcp(localPort)
    client.write('manager')
    expect((await readTcp(client)).toString()).toBe('manager')
    client.destroy()
    await manager.stop(created.id)
    expect(manager.list()[0]?.state).toBe('stopped')
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('autoStart 单条端口冲突不影响其他映射', async () => {
    const target = await listenTcpEcho()
    const validPort = await freeTcpPort()
    const occupied = await listenTcpEcho()
    const { manager, logger } = await createManager()
    const common = { protocol: 'tcp' as const, localAddr: '127.0.0.1', redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: true }
    await manager.create({ ...common, localPort: validPort })
    await manager.create({ ...common, localPort: occupied.port })
    await manager.autoStart()
    expect(manager.list().map((item) => item.state).sort()).toEqual(['error', 'running'])
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
    await closeTcpServer(occupied.server)
  })

  it('stop 不存在的映射抛出 MAPPING_NOT_FOUND', async () => {
    const { manager, logger } = await createManager()
    await expect(manager.stop('nonexistent')).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND' })
    await expect(manager.start('nonexistent')).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND' })
    await manager.stopAll()
    await logger.close()
  })

  it('update 运行中的映射会先停止再重启', async () => {
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await manager.start(created.id)
    expect(manager.list()[0]?.state).toBe('running')
    const updated = await manager.update(created.id, { autoStart: true })
    expect(updated.autoStart).toBe(true)
    expect(manager.list()[0]?.state).toBe('running')
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('update 停止状态的映射不触发 startRuntime', async () => {
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    const updated = await manager.update(created.id, { autoStart: true })
    expect(updated.autoStart).toBe(true)
    expect(manager.list()[0]?.state).toBe('stopped')
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('remove 运行中的映射会先停止再删除', async () => {
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await manager.start(created.id)
    await manager.remove(created.id)
    expect(manager.list()).toEqual([])
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('merge 批量创建并发布事件', async () => {
    const target = await listenTcpEcho()
    const port1 = await freeTcpPort()
    const port2 = await freeTcpPort()
    const { manager, logger } = await createManager()
    const result = await manager.merge([
      { protocol: 'tcp', localAddr: '127.0.0.1', localPort: port1, redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false },
      { protocol: 'tcp', localAddr: '127.0.0.1', localPort: port2, redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false },
    ])
    expect(result).toHaveLength(2)
    expect(manager.list()).toHaveLength(2)
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('UDP 映射启停并通过统计回调报告状态', async () => {
    const target = await listenUdpEcho()
    const localPort = await freeUdpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'udp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await manager.start(created.id)
    expect(manager.list()[0]?.state).toBe('running')
    const client = createSocket('udp4')
    const reply = await udpRoundTrip(client, Buffer.from('udp-test'), localPort)
    expect(reply.toString()).toBe('udp-test')
    await client.close()
    await manager.stop(created.id)
    expect(manager.list()[0]?.state).toBe('stopped')
    await manager.stopAll()
    await logger.close()
    await closeUdp(target.socket)
  })

  it('stopAll 在扩展关闭后阻止新操作（assertOpen）', async () => {
    const { manager, logger } = await createManager()
    await manager.stopAll()
    await expect(manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort: 19999,
      redirectAddr: '127.0.0.1', redirectPort: 22, autoStart: false,
    })).rejects.toMatchObject({ code: 'MAPPING_STATE' })
    await logger.close()
  })

  it('start 已运行映射直接返回当前快照（幂等）', async () => {
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    const { manager, logger } = await createManager()
    const created = await manager.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await manager.start(created.id)
    const second = await manager.start(created.id)
    expect(second.state).toBe('running')
    await manager.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })

  it('initialize 两次加载已有映射快照', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-manager-'))
    const logger = new AppLogger(join(directory, 'log'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    const events = new RuntimeEventHub()
    const manager1 = new MappingManager(store, logger, events)
    await manager1.initialize()
    const target = await listenTcpEcho()
    const localPort = await freeTcpPort()
    await manager1.create({
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    })
    await manager1.stopAll()

    const store2 = new MappingStore(join(directory, 'mappings.json'))
    const manager2 = new MappingManager(store2, logger, events)
    await manager2.initialize()
    expect(manager2.list()).toHaveLength(1)
    expect(manager2.list()[0]?.state).toBe('stopped')
    await manager2.stopAll()
    await logger.close()
    await closeTcpServer(target.server)
  })
})

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'
import { MappingManager } from '../src/ext/port-log/mapping-manager.ts'
import { MappingStore } from '../src/ext/port-log/mapping-store.ts'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'
import { closeTcpServer, connectTcp, freeTcpPort, listenTcpEcho, readTcp } from './ext-port-log-helpers.ts'

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
})

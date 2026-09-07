import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TcpForwarder } from '../src/ext/port-log/tcp-forwarder.ts'
import type { ForwarderStats, PortMappingConfig } from '../src/ext/port-log/types.ts'
import { closeTcpServer, connectTcp, freeTcpPort, listenTcpEcho, readTcp } from './ext-port-log-helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup())) })

function config(localPort: number, redirectPort: number, localAddr = '127.0.0.1'): PortMappingConfig {
  return { id: 'tcp-1', protocol: 'tcp', localAddr, localPort, redirectAddr: localAddr, redirectPort, autoStart: false }
}

describe('port-log TCP 映射', () => {
  it('多个连接双向转发且统计字节和活动数', async () => {
    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort()
    let latest: ForwarderStats | undefined
    const forwarder = new TcpForwarder(config(localPort, target.port), (stats) => { latest = stats })
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const clients = await Promise.all([connectTcp(localPort), connectTcp(localPort)])
    for (const [index, client] of clients.entries()) {
      const message = Buffer.from(`hello-${index}`)
      client.write(message)
      expect(await readTcp(client)).toEqual(message)
      client.destroy()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(latest).toMatchObject({ bytesClientToTarget: 14, bytesTargetToClient: 14 })
  })

  it('目标拒绝不关闭监听，目标恢复后下一连接成功', async () => {
    const targetPort = await freeTcpPort()
    const localPort = await freeTcpPort()
    const forwarder = new TcpForwarder(config(localPort, targetPort), () => undefined, 200)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const failed = await connectTcp(localPort)
    failed.on('error', () => undefined)
    await new Promise<void>((resolve) => failed.once('close', () => resolve()))

    const target = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => target.listen(targetPort, '127.0.0.1', resolve))
    cleanups.push(() => closeTcpServer(target))
    const client = await connectTcp(localPort)
    client.write('recovered')
    expect((await readTcp(client)).toString()).toBe('recovered')
    client.destroy()
  })

  it('端口冲突返回安全错误，stop 后端口可复用', async () => {
    const occupied = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(occupied.server))
    const forwarder = new TcpForwarder(config(occupied.port, occupied.port), () => undefined)
    await expect(forwarder.start()).rejects.toMatchObject({ code: 'PORT_IN_USE' })

    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort()
    const running = new TcpForwarder(config(localPort, target.port), () => undefined)
    await running.start()
    await running.stop()
    const rebound = createServer()
    await new Promise<void>((resolve) => rebound.listen(localPort, '127.0.0.1', resolve))
    await closeTcpServer(rebound)
  })

  it('环境支持时完成 IPv6 双向转发', async () => {
    let target: Awaited<ReturnType<typeof listenTcpEcho>>
    try {
      target = await listenTcpEcho('::1')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return
      throw error
    }
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort('::1')
    const forwarder = new TcpForwarder(config(localPort, target.port, '::1'), () => undefined)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const client = await connectTcp(localPort, '::1')
    client.write('ipv6')
    expect((await readTcp(client)).toString()).toBe('ipv6')
    client.destroy()
  })
})

import { createServer, type Socket } from 'node:net'
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

  it('目标连接超时触发 reportError 并销毁客户端', async () => {
    // 使用一个会被丢弃的目标端口（不监听任何服务，触发连接超时）
    // 注意：实际超时依赖 connectTimeoutMs，这里用较短的超时
    const localPort = await freeTcpPort()
    let latest: ForwarderStats | undefined
    // 使用不可达地址触发超时（10.255.255.1 通常不可达）
    const forwarderConfig: PortMappingConfig = {
      id: 'tcp-timeout', protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '10.255.255.1', redirectPort: 9999, autoStart: false,
    }
    const forwarder = new TcpForwarder(forwarderConfig, (stats) => { latest = stats }, 200)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const client = await connectTcp(localPort)
    client.on('error', () => undefined)
    // 等待超时触发
    await new Promise<void>((resolve) => client.once('close', () => resolve()))
    expect(latest?.lastError).toBeTruthy()
  })

  it('客户端错误时销毁目标连接', async () => {
    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort()
    const forwarder = new TcpForwarder(config(localPort, target.port), () => undefined)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const client = await connectTcp(localPort)
    client.on('error', () => undefined)
    // 触发 client error：强制销毁
    client.destroy()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  it('stop 时活跃连接在 drain 超时后被强制清理', async () => {
    // 使用一个不回显且不主动关闭的目标
    const targetSockets: Socket[] = []
    const targetServer = createServer((socket) => { socket.on('error', () => undefined); targetSockets.push(socket) })
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve))
    const targetPort = (targetServer.address() as any).port
    const localPort = await freeTcpPort()
    let latest: ForwarderStats | undefined
    const forwarder = new TcpForwarder(config(localPort, targetPort), (stats) => { latest = stats }, 3000, 50)
    await forwarder.start()
    const client = await connectTcp(localPort)
    client.on('error', () => undefined)
    // 等待连接建立到目标
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(latest?.activeCount).toBe(1)
    // stop 会 drain 超时后强制销毁所有 pair，activeCount 归零
    const stopPromise = forwarder.stop()
    await new Promise((resolve) => setTimeout(resolve, 60))
    for (const s of targetSockets) s.destroy()
    await stopPromise
    // stop 后 activeCount 应回零
    expect(latest?.activeCount).toBe(0)
    await new Promise<void>((resolve) => targetServer.close(() => resolve()))
  })

  it('重复 start 不重新监听（幂等）', async () => {
    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort()
    const forwarder = new TcpForwarder(config(localPort, target.port), () => undefined)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    await forwarder.start() // 幂等，不应抛异常
    const client = await connectTcp(localPort)
    client.write('idempotent')
    expect((await readTcp(client)).toString()).toBe('idempotent')
    client.destroy()
  })

  it('无连接时 stop 立即返回', async () => {
    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    const localPort = await freeTcpPort()
    const forwarder = new TcpForwarder(config(localPort, target.port), () => undefined)
    await forwarder.start()
    await forwarder.stop()
    // 再次 stop 也应幂等
    await expect(forwarder.stop()).resolves.toBeUndefined()
  })

  it('监听地址不可用返回 ADDRESS_INVALID', async () => {
    const target = await listenTcpEcho()
    cleanups.push(() => closeTcpServer(target.server))
    // 使用不可用的监听地址
    const badConfig: PortMappingConfig = {
      id: 'tcp-bad', protocol: 'tcp', localAddr: '192.0.2.1', localPort: 0,
      redirectAddr: '127.0.0.1', redirectPort: target.port, autoStart: false,
    }
    const forwarder = new TcpForwarder(badConfig, () => undefined)
    await expect(forwarder.start()).rejects.toMatchObject({ code: 'ADDRESS_INVALID' })
  })
})

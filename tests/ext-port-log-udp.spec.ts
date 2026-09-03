import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { UdpForwarder } from '../src/ext/port-log/udp-forwarder.ts'
import type { ForwarderStats, PortMappingConfig } from '../src/ext/port-log/types.ts'
import { closeUdp, freeUdpPort, listenUdpEcho, udpRoundTrip } from './ext-port-log-helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup())) })

function config(localPort: number, redirectPort: number, localAddr = '127.0.0.1'): PortMappingConfig {
  return { id: 'udp-1', protocol: 'udp', localAddr, localPort, redirectAddr: localAddr, redirectPort, autoStart: false }
}

describe('port-log UDP 映射', () => {
  it('隔离两个来源、保留报文边界并统计字节', async () => {
    const target = await listenUdpEcho()
    cleanups.push(() => closeUdp(target.socket))
    const localPort = await freeUdpPort()
    let latest: ForwarderStats | undefined
    const forwarder = new UdpForwarder(config(localPort, target.port), (stats) => { latest = stats })
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const clients = [createSocket('udp4'), createSocket('udp4')]
    cleanups.push(...clients.map((client) => () => closeUdp(client)))
    const [left, right] = await Promise.all([
      udpRoundTrip(clients[0]!, Buffer.from('left'), localPort),
      udpRoundTrip(clients[1]!, Buffer.from('right'), localPort),
    ])
    expect(left.toString()).toBe('left')
    expect(right.toString()).toBe('right')
    expect(latest).toMatchObject({ activeCount: 2, bytesClientToTarget: 9, bytesTargetToClient: 9 })
  })

  it('转发零长度数据报并在 stop 后释放端口', async () => {
    const target = await listenUdpEcho()
    cleanups.push(() => closeUdp(target.socket))
    const localPort = await freeUdpPort()
    const forwarder = new UdpForwarder(config(localPort, target.port), () => undefined)
    await forwarder.start()
    const client = createSocket('udp4')
    cleanups.push(() => closeUdp(client))
    expect((await udpRoundTrip(client, Buffer.alloc(0), localPort)).length).toBe(0)
    await forwarder.stop()
    const rebound = createSocket('udp4')
    await new Promise<void>((resolve) => rebound.bind(localPort, '127.0.0.1', resolve))
    await closeUdp(rebound)
  })

  it('端口冲突返回安全错误', async () => {
    const occupied = await listenUdpEcho()
    cleanups.push(() => closeUdp(occupied.socket))
    const forwarder = new UdpForwarder(config(occupied.port, occupied.port), () => undefined)
    await expect(forwarder.start()).rejects.toMatchObject({ code: 'PORT_IN_USE' })
  })

  it('环境支持时完成 IPv6 数据报转发', async () => {
    let target: Awaited<ReturnType<typeof listenUdpEcho>>
    try {
      target = await listenUdpEcho('::1')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return
      throw error
    }
    cleanups.push(() => closeUdp(target.socket))
    const localPort = await freeUdpPort('::1')
    const forwarder = new UdpForwarder(config(localPort, target.port, '::1'), () => undefined)
    await forwarder.start()
    cleanups.push(() => forwarder.stop())
    const client = createSocket('udp6')
    cleanups.push(() => closeUdp(client))
    expect((await udpRoundTrip(client, Buffer.from('ipv6'), localPort, '::1')).toString()).toBe('ipv6')
  })
})

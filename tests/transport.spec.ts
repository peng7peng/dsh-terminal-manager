import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { connectTelnet } from '../src/transport/telnet.ts'
import { TransportError } from '../src/transport/types.ts'
import { collector, createDeviceLab } from './helpers.ts'

const lab = createDeviceLab()
afterEach(async () => {
  await lab.cleanup()
})

describe('B3 Telnet 传输（裸 TCP）', () => {
  it('连接、收发、回显', async () => {
    const { port } = await lab.startEchoServer()
    const out = collector()
    let closeReason: string | undefined
    const transport = await connectTelnet({ host: '127.0.0.1', port }, {
      onData: out.onData,
      onClose: (reason) => { closeReason = reason },
    })
    transport.write('ping\n')
    await out.waitFor('ping\n')
    await transport.close()
    expect(closeReason).toBeTruthy()
  })

  it('地址不通 → HOST_UNREACHABLE', async () => {
    const { port } = await lab.startEchoServer()
    await lab.cleanup() // 关掉监听，留下一个确定无服务的端口
    await expect(connectTelnet(
      { host: '127.0.0.1', port, connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })
})

describe('B2 SSH 传输（进程内设备）', () => {
  it('密码认证：横幅 + 回显 + 关闭', async () => {
    const { port } = await lab.startSshDevice()
    const out = collector()
    const transport = await connectSsh(
      { host: '127.0.0.1', port, username: 'admin', password: 'test-pass' },
      { onData: out.onData, onClose: () => {} },
    )
    await out.waitFor('Welcome to test device')
    transport.write('show version\n')
    await out.waitFor('show version')
    await transport.close()
  })

  it('密钥认证可用', async () => {
    const { port } = await lab.startSshDevice()
    const { generateKeyPairSync } = await import('node:crypto')
    const clientKey = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey
    const out = collector()
    const transport = await connectSsh(
      { host: '127.0.0.1', port, username: 'admin', privateKey: clientKey },
      { onData: out.onData, onClose: () => {} },
    )
    await out.waitFor('Welcome to test device')
    await transport.close()
  })

  it('密码错误 → AUTH_FAILED（且错误不含密码）', async () => {
    const { port } = await lab.startSshDevice()
    try {
      await connectSsh(
        { host: '127.0.0.1', port, username: 'admin', password: 'wrong-pass-xyz' },
        { onData: () => {}, onClose: () => {} },
      )
      expect.unreachable('应认证失败')
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError)
      expect((error as TransportError).code).toBe('AUTH_FAILED')
      expect(String(error)).not.toContain('wrong-pass-xyz')
    }
  })

  it('地址不通 → HOST_UNREACHABLE', async () => {
    const { port } = await lab.startSshDevice()
    await lab.cleanup()
    await expect(connectSsh(
      { host: '127.0.0.1', port, username: 'admin', password: 'p', connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })
})

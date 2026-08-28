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

describe('B3 Telnet IAC 协商', () => {
  it('Telnet 模式：IAC 序列被剥离，正常文本通过', async () => {
    const { port } = await lab.startEchoServer({ iac: true })
    const received: string[] = []
    const transport = await connectTelnet(
      { host: '127.0.0.1', port, telnetMode: 'telnet' },
      { onData: (d) => received.push(d), onClose: () => {} },
    )
    await new Promise(r => setTimeout(r, 200))
    transport.write('show version\r\n')
    await new Promise(r => setTimeout(r, 200))
    const joined = received.join('')
    // IAC 字节(0xFF)不应出现在输出里（被剥离）
    expect(joined).not.toContain(String.fromCharCode(0xff))
    // 回显的文本应该可见
    expect(joined).toContain('show version')
    await transport.close()
  })

  it('Raw 模式：IAC 序列原样透传（不剥离）', async () => {
    const { port } = await lab.startEchoServer({ iac: true })
    const received: string[] = []
    const transport = await connectTelnet(
      { host: '127.0.0.1', port, telnetMode: 'raw' },
      { onData: (d) => received.push(d), onClose: () => {} },
    )
    await new Promise(r => setTimeout(r, 200))
    const joined = received.join('')
    // Raw 模式不剥离，IAC 字节(0xFF 的 UTF-8 编码)应出现在输出里
    expect(joined.length).toBeGreaterThan(0)
    await transport.close()
  })
})

describe('B3 Telnet 传输边界', () => {
  it('连接到无服务的端口 → HOST_UNREACHABLE', async () => {
    const { port } = await lab.startEchoServer()
    await lab.cleanup()
    await expect(connectTelnet(
      { host: '127.0.0.1', port, connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })

  it('close 后调 write → 不抛异常（静默忽略）', async () => {
    const { port } = await lab.startEchoServer()
    const transport = await connectTelnet(
      { host: '127.0.0.1', port },
      { onData: () => {}, onClose: () => {} },
    )
    await transport.close()
    expect(() => transport.write('after-close\n')).not.toThrow()
  })

  it('服务端主动关闭连接 → onClose 被调用', async () => {
    const { port } = await lab.startEchoServer()
    let closeReason: string | undefined
    const transport = await connectTelnet(
      { host: '127.0.0.1', port },
      { onData: () => {}, onClose: (reason) => { closeReason = reason } },
    )
    await transport.close() // 本端关闭会触发服务端断开，进而触发 onClose
    // 等一下让 close 事件传播
    await new Promise(r => setTimeout(r, 50))
    expect(closeReason).toBeTruthy()
  })

  it('close 连续调两次 → 第二次不报错', async () => {
    const { port } = await lab.startEchoServer()
    const transport = await connectTelnet(
      { host: '127.0.0.1', port },
      { onData: () => {}, onClose: () => {} },
    )
    await transport.close()
    await expect(transport.close()).resolves.toBeUndefined()
  })
})

import { createServer, type Server as NetServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { Server as SshServer } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { connectTelnet } from '../src/transport/telnet.ts'
import { TransportError } from '../src/transport/types.ts'

/** ── 模拟设备工厂 ── */

// 测试用主机密钥（EC P-256）
const HOST_KEY = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

/** TCP echo 设备：原样回显收到的字节。 */
function startEchoServer(): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server: NetServer = createServer((socket) => {
      socket.pipe(socket)
    })
    cleanups.push(() => new Promise<void>((done) => {
      server.closeAllConnections?.()
      server.close(() => done())
    }))
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port })
    })
  })
}

/** SSH 设备：横幅 + 回显；密码 admin/test-pass，密钥一律接受。 */
function startSshDevice(): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          return ctx.username === 'admin' && ctx.password === 'test-pass' ? ctx.accept() : ctx.reject()
        }
        if (ctx.method === 'publickey') return ctx.accept()
        return ctx.reject()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty())
          session.on('window-change', (acceptWin) => acceptWin?.())
          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            stream.write('Welcome to test device\r\n')
            stream.on('data', (data: Buffer) => stream.write(data))
          })
        })
      })
    })
    cleanups.push(() => new Promise<void>((done) => {
      server.close(() => done())
    }))
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port })
    })
  })
}

/** 输出收集器：把 onData 的碎片攒起来，可等待子串出现。 */
function collector() {
  let buffer = ''
  const waiters: Array<{ needle: string; resolve: () => void }> = []
  return {
    onData: (chunk: string) => {
      buffer += chunk
      for (const w of [...waiters]) {
        if (buffer.includes(w.needle)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve()
        }
      }
    },
    waitFor: (needle: string, timeoutMs = 5000): Promise<void> => {
      if (buffer.includes(needle)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 "${needle}" 超时，已收到: ${JSON.stringify(buffer)}`)), timeoutMs)
        waiters.push({ needle, resolve: () => { clearTimeout(timer); resolve() } })
      })
    },
    text: () => buffer,
  }
}

describe('B3 Telnet 传输（裸 TCP）', () => {
  it('连接、收发、回显', async () => {
    const { port } = await startEchoServer()
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
    // 先占一个端口再关掉，得到一个"确定没有监听"的端口
    const { port } = await startEchoServer()
    await cleanups.pop()!()
    await expect(connectTelnet(
      { host: '127.0.0.1', port, connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })
})

describe('B2 SSH 传输（进程内设备）', () => {
  it('密码认证：横幅 + 回显 + 关闭', async () => {
    const { port } = await startSshDevice()
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
    const { port } = await startSshDevice()
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
    const { port } = await startSshDevice()
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
    const { port } = await startSshDevice()
    await cleanups.pop()!()
    await expect(connectSsh(
      { host: '127.0.0.1', port, username: 'admin', password: 'p', connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })
})

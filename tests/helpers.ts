/**
 * 测试用模拟设备工厂：进程内起"假设备"，集成测试不依赖真实设备。
 */
import { createServer, type Server as NetServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { Server as SshServer } from 'ssh2'

// 测试用主机密钥（EC P-256）
export const HOST_KEY = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

/** 输出收集器：把 onData 的碎片攒起来，可等待子串出现。 */
export function collector() {
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

/** 设备实验室：统一登记清理。 */
export function createDeviceLab() {
  const cleanups: Array<() => Promise<void>> = []

  return {
    /** TCP echo 设备：原样回显收到的字节。 */
    startEchoServer(): Promise<{ port: number }> {
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
    },

    /** SSH 设备：横幅 + 回显；密码 admin/test-pass，密钥一律接受。 */
    startSshDevice(): Promise<{ port: number }> {
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
    },

    async cleanup(): Promise<void> {
      while (cleanups.length > 0) {
        await cleanups.pop()!()
      }
    },
  }
}

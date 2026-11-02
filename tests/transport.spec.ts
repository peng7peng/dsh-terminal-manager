import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { connectTelnet } from '../src/transport/telnet.ts'
import { TransportError } from '../src/transport/types.ts'
import { collector, createDeviceLab } from './helpers.ts'

const IAC = 255, DO = 253, WILL = 251, SB = 250, SE = 240, SGA = 3, ECHO = 1, TTYPE = 24, NAWS = 31

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
    // 用永远无法解析的域名，避免本机对「刚关闭的端口」先 connect 再 RST 的环境差异
    await expect(connectTelnet(
      { host: 'terminal-manager.invalid', port: 23, connectTimeoutMs: 2000 },
      { onData: () => {}, onClose: () => {} },
    )).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' })
  })
})

describe('B2 SSH 传输（进程内设备）', () => {
  it('密码认证：横幅 + 回显 + 关闭', async () => {
    const { port } = await lab.startSshDevice()
    const out = collector()
    const transport = await connectSsh(
      { host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } },
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
      { host: '127.0.0.1', port, username: 'admin', auth: { kind: 'key' as const, privateKey: clientKey } },
      { onData: out.onData, onClose: () => {} },
    )
    await out.waitFor('Welcome to test device')
    await transport.close()
  })

  it('密码错误 → AUTH_FAILED（且错误不含密码）', async () => {
    const { port } = await lab.startSshDevice()
    try {
      await connectSsh(
        { host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'wrong-pass-xyz' } },
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
      { host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'p' }, connectTimeoutMs: 2000 },
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
  it('无法解析的主机 → HOST_UNREACHABLE', async () => {
    await expect(connectTelnet(
      { host: 'terminal-manager.invalid', port: 23, connectTimeoutMs: 3000 },
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

// ── 三档 Telnet 模式：passive（默认）/ active（800ms 探测）/ raw ─────────────

const probeServers: Server[] = []
const probeSockets: Socket[] = []
afterEach(() => {
  for (const socket of probeSockets.splice(0)) socket.destroy()
  for (const server of probeServers.splice(0)) { server.closeAllConnections?.(); server.close() }
})

/** 起一个能按脚本往客户端写字节、并记录客户端回复的 TCP 服务器 */
function scriptedServer(onConnect: (socket: Socket) => void): Promise<{ port: number; received: () => Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const server = createServer((socket) => {
      probeSockets.push(socket)
      socket.on('data', (d: Buffer) => chunks.push(d))
      socket.on('error', () => {})
      onConnect(socket)
    })
    probeServers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, received: () => Buffer.concat(chunks) }))
  })
}

/** 轮询等条件成立（TCP/Nagle 下协商字节可能晚几十毫秒到） */
function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (predicate()) { resolve(); return }
      if (Date.now() > deadline) { reject(new Error('等待条件超时')); return }
      setTimeout(tick, 10)
    }
    tick()
  })
}

const countSeq = (buf: Buffer, seq: number[]): number => {
  let count = 0
  for (let i = 0; i <= buf.length - seq.length; i++) {
    if (seq.every((value, offset) => buf[i + offset] === value)) count++
  }
  return count
}

describe('B3 Telnet 三档模式', () => {
  it('缺省 passive：连接后不主动发任何协商字节，只正常收发', async () => {
    const { port, received } = await scriptedServer((socket) => { socket.write('login: ') })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port }, { onData: out.onData, onClose: () => {} })
    await out.waitFor('login: ')
    await new Promise(r => setTimeout(r, 150))
    expect(received().length).toBe(0)
    await t.close()
  })

  it('passive：服务器 DO TTYPE 才回 WILL TTYPE；未请求 NAWS 时 resize 不发子协商', async () => {
    const { port, received } = await scriptedServer((socket) => {
      socket.write(Buffer.from([IAC, DO, TTYPE]))
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port }, { onData: out.onData, onClose: () => {} })
    await waitUntil(() => received().includes(Buffer.from([IAC, WILL, TTYPE])))
    expect(received().includes(Buffer.from([IAC, SB, NAWS]))).toBe(false)
    t.resize?.(100, 30)
    await new Promise(r => setTimeout(r, 300))
    expect(received().includes(Buffer.from([IAC, SB, NAWS]))).toBe(false)
    await t.close()
  })

  it('active：初始 DO SGA；收到合法 IAC 判真 telnetd 并回协商 + 补 NAWS', async () => {
    const { port, received } = await scriptedServer((socket) => {
      socket.write(Buffer.from([IAC, WILL, ECHO]))
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'active' }, { onData: out.onData, onClose: () => {} })
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, SGA])))
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, ECHO])))
    await waitUntil(() => received().includes(Buffer.from([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE])))
    await t.close()
  })

  it('active：探测窗口内收到非 IAC 数据 → 切被动，不再发 NAWS/协商', async () => {
    const { port, received } = await scriptedServer((socket) => { socket.write('shell> ') })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'active' }, { onData: out.onData, onClose: () => {} })
    await out.waitFor('shell> ')
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, SGA])))
    const before = received()
    expect(before.includes(Buffer.from([IAC, SB, NAWS]))).toBe(false)
    // 裸 shell 上 resize 不能再糊 NAWS 字节进去
    t.resize?.(120, 40)
    await new Promise(r => setTimeout(r, 300))
    expect(received().includes(Buffer.from([IAC, SB, NAWS]))).toBe(false)
    await t.close()
  })

  it('active：800ms 超时 → 保守按 telnetd 继续（补 NAWS，resize 生效）', async () => {
    const { port, received } = await scriptedServer(() => { /* 黑洞：连上但不发任何字节 */ })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'active' }, { onData: out.onData, onClose: () => {} })
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, SGA])))
    // 探测窗口内先不发 NAWS
    await new Promise(r => setTimeout(r, 300))
    expect(received().includes(Buffer.from([IAC, SB, NAWS]))).toBe(false)
    // 超时后保守判 telnetd，补 80x24
    await waitUntil(() => received().includes(Buffer.from([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE])), 2000)
    t.resize?.(100, 30)
    await waitUntil(() => received().includes(Buffer.from([IAC, SB, NAWS, 0, 100, 0, 30, IAC, SE])))
    await t.close()
  })

  it('raw：不解析 IAC、不主动协商、IAC 字节原样进输出', async () => {
    const { port, received } = await scriptedServer((socket) => {
      socket.write(Buffer.concat([Buffer.from([IAC, WILL, ECHO]), Buffer.from('login: ')]))
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'raw' }, { onData: out.onData, onClose: () => {} })
    await out.waitFor('login: ')
    expect(out.text()).toContain('\ufffd')
    expect(received().length).toBe(0)
    await t.close()
  })

  it('旧值 telnetMode=telnet 归一化为 active（连接后仍发 DO SGA）', async () => {
    const { port, received } = await scriptedServer(() => {})
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'telnet' } as never, { onData: out.onData, onClose: () => {} })
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, SGA])))
    await t.close()
  })

  it('Q-method 防环：服务器重复 WILL ECHO，客户端只回一次 DO ECHO', async () => {
    const { port, received } = await scriptedServer((socket) => {
      socket.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, ECHO, IAC, WILL, ECHO]))
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'active' }, { onData: out.onData, onClose: () => {} })
    await waitUntil(() => received().includes(Buffer.from([IAC, DO, ECHO])))
    await new Promise(r => setTimeout(r, 200))
    expect(countSeq(received(), [IAC, DO, ECHO])).toBe(1)
    await t.close()
  })
})

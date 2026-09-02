/**
 * 传输层补充：Telnet IAC 协商的各分支（DO TTYPE / NAWS / 其他、SB TTYPE SEND、IAC IAC、未知命令、SB 异常）、
 * 连接超时；SSH resize 与协议错误映射。全部用进程内假服务器。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { connectTelnet } from '../src/transport/telnet.ts'
import { TransportError } from '../src/transport/types.ts'
import { collector, createDeviceLab } from './helpers.ts'

const IAC = 255, DO = 253, WILL = 251, WONT = 252, SB = 250, SE = 240, TTYPE = 24, NAWS = 31, NOP = 241

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close() }
})

/** 起一个能按脚本往客户端写字节、并记录客户端回复的 TCP 服务器 */
function scriptedServer(onConnect: (socket: Socket) => void): Promise<{ port: number; received: () => Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const server = createServer((socket) => {
      sockets.push(socket)
      socket.on('data', (d: Buffer) => chunks.push(d))
      socket.on('error', () => {})
      onConnect(socket)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, received: () => Buffer.concat(chunks) }))
  })
}

describe('Telnet IAC 协商分支', () => {
  it('DO TTYPE → WILL TTYPE；DO NAWS → WILL NAWS；DO 其他 → WONT；SB TTYPE SEND → 回终端类型 xterm', async () => {
    const { port, received } = await scriptedServer((socket) => {
      socket.write(Buffer.from([IAC, DO, TTYPE, IAC, DO, NAWS, IAC, DO, 99, IAC, SB, TTYPE, 1, IAC, SE]))
      socket.write('login: ')
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'telnet' } as never, { onData: out.onData, onClose: () => {} })
    await out.waitFor('login: ')
    await new Promise(r => setTimeout(r, 50))
    const got = received()
    const has = (seq: number[]): boolean => got.includes(Buffer.from(seq))
    expect(has([IAC, WILL, TTYPE])).toBe(true)
    expect(has([IAC, WILL, NAWS])).toBe(true)
    expect(has([IAC, WONT, 99])).toBe(true)
    expect(got.includes(Buffer.from('xterm', 'ascii'))).toBe(true)
    expect(out.text()).not.toContain('ÿ')
    await t.close()
  })

  it('IAC IAC = 数据字节 255；未知 IAC 命令忽略；SB 里的 IAC IAC 与异常字节都不崩', async () => {
    const { port } = await scriptedServer((socket) => {
      socket.write(Buffer.concat([
        Buffer.from('A'), Buffer.from([IAC, IAC]), Buffer.from('B'),
        Buffer.from([IAC, NOP]),
        Buffer.from([IAC, SB, TTYPE, IAC, IAC, 7, IAC, 5]),   // SB 内 IAC IAC，然后 IAC + 非 SE 非 IAC → 重置
        Buffer.from('C'),
      ]))
    })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'telnet' } as never, { onData: out.onData, onClose: () => {} })
    await out.waitFor('C')
    const text = out.text()
    expect(text).toContain('A')
    expect(text).toContain('B')
    // 单独一个 0xff 不是合法 UTF-8，解码成替换符；关键是它作为「数据」被保留且没把后面的 B 吃掉
    expect(text.indexOf('A') < text.indexOf('B') && text.indexOf('B') < text.indexOf('C')).toBe(true)
    expect(text.length).toBeGreaterThan(3)
    await t.close()
  })

  it('连接超时 → CONN_TIMEOUT（黑洞地址，200ms）', async () => {
    try {
      await connectTelnet({ host: '192.0.2.1', port: 23, connectTimeoutMs: 200 } as never, { onData: () => {}, onClose: () => {} })
      throw new Error('should fail')
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError)
      expect(['CONN_TIMEOUT', 'HOST_UNREACHABLE']).toContain((e as TransportError).code)
    }
  }, 10_000)
})

describe('SSH 补充', () => {
  const lab = createDeviceLab()
  afterEach(() => lab.cleanup())

  it('resize 调用不抛错；服务端断开 → onClose', async () => {
    const { port } = await lab.startSshDevice()
    const out = collector()
    let closed = ''
    const t = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: out.onData, onClose: (r) => { closed = r } })
    await out.waitFor('Welcome to test device')
    expect(() => t.resize(120, 40)).not.toThrow()
    await t.close()
    await new Promise(r => setTimeout(r, 50))
    expect(closed.length).toBeGreaterThan(0)
    expect(() => t.write('after close')).not.toThrow()
  })

  it('对方不是 SSH 服务 → PROTO_ERROR / HOST_UNREACHABLE（不含凭据）', async () => {
    const { port } = await scriptedServer((socket) => { socket.write('220 not ssh\r\n'); socket.end() })
    try {
      await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'secret-pw', connectTimeoutMs: 2000 } as never, { onData: () => {}, onClose: () => {} })
      throw new Error('should fail')
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError)
      expect(['PROTO_ERROR', 'HOST_UNREACHABLE', 'CONN_TIMEOUT']).toContain((e as TransportError).code)
      expect((e as TransportError).message).not.toContain('secret-pw')
    }
  }, 10_000)
})

describe('Telnet NAWS 防抖与转义', () => {
  /** 数收到的 IAC SB NAWS 子协商条数 */
  const nawsCount = (buf: Buffer): number => {
    let n = 0
    for (let i = 0; i < buf.length - 2; i++) {
      if (buf[i] === IAC && buf[i + 1] === SB && buf[i + 2] === NAWS) n++
    }
    return n
  }

  it('resize 抖动只发一条（停稳后的最后尺寸）；尺寸不变不重发；0xFF 按 RFC 1073 转义', async () => {
    const { port, received } = await scriptedServer((socket) => { socket.write('login: ') })
    const out = collector()
    const t = await connectTelnet({ host: '127.0.0.1', port, telnetMode: 'telnet' } as never, { onData: out.onData, onClose: () => {} })
    await out.waitFor('login: ')
    await new Promise(r => setTimeout(r, 30))
    // 连接时的 80x24（#18）已发 1 条
    expect(nawsCount(received())).toBe(1)
    // 50ms 内连续 resize 10 次（模拟拖动面板 / 改列数）
    for (let i = 0; i < 10; i++) {
      t.resize?.(120 + i, 40)
      await new Promise(r => setTimeout(r, 5))
    }
    await new Promise(r => setTimeout(r, 300))
    // 抖动只出 1 条，且是停稳后的最后尺寸 129x40
    expect(nawsCount(received())).toBe(2)
    expect(received().includes(Buffer.from([IAC, SB, NAWS, 0, 129, 0, 40, IAC, SE]))).toBe(true)
    // 同尺寸再 resize：不重发
    t.resize?.(129, 40)
    await new Promise(r => setTimeout(r, 300))
    expect(nawsCount(received())).toBe(2)
    // cols=255 → 低字节 0xFF 必须写成 FF FF（否则对端解析错位）
    t.resize?.(255, 41)
    await new Promise(r => setTimeout(r, 300))
    expect(received().includes(Buffer.from([IAC, SB, NAWS, 0, 0xff, 0xff, 0, 41, IAC, SE]))).toBe(true)
    await t.close()
  }, 8000)
})

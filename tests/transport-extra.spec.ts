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

describe('SSH SFTP（S5 步骤1）', () => {
  const lab = createDeviceLab()
  afterEach(() => lab.cleanup())

  it('open 会话可取 sftp（懒开子通道，复用同一连接）', async () => {
    const { port } = await lab.startSshDeviceWithSftp()
    const out = collector()
    const t = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: out.onData, onClose: () => {} })
    const sftp = await t.getSftp!()
    expect(typeof sftp.fastGet).toBe('function')
    expect(typeof sftp.fastPut).toBe('function')
    // 同一会话可再次懒开（复用 Client，不互相影响）
    const sftp2 = await t.getSftp!()
    expect(typeof sftp2.readdir).toBe('function')
    await t.close()
  })

  it('close 后取用抛 DISCONNECTED', async () => {
    const { port } = await lab.startSshDeviceWithSftp()
    const out = collector()
    const t = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: out.onData, onClose: () => {} })
    await t.close()
    await expect(t.getSftp!()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  it('设备未开 sftp 子系统 → PROTO_ERROR（消息不含凭据）', async () => {
    const { port } = await lab.startSshDevice()
    const out = collector()
    const t = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: out.onData, onClose: () => {} })
    await out.waitFor('Welcome to test device')
    try {
      await t.getSftp!()
      throw new Error('should fail')
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError)
      expect((e as TransportError).code).toBe('PROTO_ERROR')
      expect((e as TransportError).message).not.toContain('test-pass')
    }
    await t.close()
  })
})

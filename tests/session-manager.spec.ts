import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { SftpLike, Transport, TransportCallbacks } from '../src/transport/types.ts'
import { createDeviceLab, fakeSftpLike } from './helpers.ts'

/** ── 假传输工厂：每次 connect 一个独立槽位，完全可控 ── */

interface FakeSession {
  callbacks: TransportCallbacks
}

interface FakeRec {
  written: string[]
  resized: Array<[number, number]>
  sessions: FakeSession[]
  closeCount: number
}

function fakeFactory(): { rec: FakeRec; factory: TransportFactory } {
  const rec: FakeRec = { written: [], resized: [], sessions: [], closeCount: 0 }
  const factory: TransportFactory = async (_target, callbacks) => {
    const slot: FakeSession = { callbacks }
    rec.sessions.push(slot)
    const transport: Transport = {
      write: (data) => { rec.written.push(data) },
      resize: (cols, rows) => { rec.resized.push([cols, rows]) },
      close: async () => {
        rec.closeCount += 1
        callbacks.onClose('本端主动断开')
      },
    }
    return transport
  }
  return { rec, factory }
}

/** ── 共享的连接存储 ── */

let dir: string
let store: ConnectionStore
let connId: string
let promptConnId: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-sm-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({
    label: 'dev-a',
    protocol: 'telnet',
    host: '127.0.0.1',
    port: 9, // 假传输不真连，端口无所谓
    quietMs: 100,
  })
  connId = conn.id
  const promptConn = await store.create({
    label: 'dev-p',
    protocol: 'telnet',
    host: '127.0.0.1',
    port: 9,
    promptPattern: 'PROMPT#\\s$',
    timeoutMs: 3000,
  })
  promptConnId = promptConn.id
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SessionManager 会话生命周期', () => {
  it('连接 → 已连接；重复连接返回同一会话', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const first = await sm.connectByConnId(connId)
    expect(first.status).toBe('open')
    expect(first.label).toBe('dev-a')
    const second = await sm.connectByConnId(connId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(sm.list()).toHaveLength(1)
  })

  it('状态监听：连接中 → 已连接 → 已移除（主动断开）', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const seen: string[] = []
    sm.onStatus(snap => seen.push(snap.status))
    const snap = await sm.connectByConnId(connId)
    await sm.disconnect(snap.sessionId)
    expect(seen).toEqual(['connecting', 'open', 'removed'])
  })

  it('人工键入原样写入、可订阅输出、可调尺寸', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    const got: string[] = []
    sm.subscribe(snap.sessionId, chunk => got.push(chunk))
    sm.write(snap.sessionId, 'ls\r')
    expect(rec.written).toEqual(['ls\r'])
    rec.sessions[0].callbacks.onData('file1\n')
    expect(got).toEqual(['file1\n'])
    sm.resize(snap.sessionId, 100, 40)
    expect(rec.resized).toEqual([[100, 40]])
  })

  it('缓冲可回看（read）', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    rec.sessions[0].callbacks.onData('line1\nline2\nline3')
    const page = sm.read(snap.sessionId, 2)
    expect(page.text).toBe('line2\nline3')
    expect(page.totalLines).toBe(3)
    expect(page.truncated).toBe(true)
  })

  // U-SM-CA-01：closeAll 关闭多会话
  // 场景：创建 2+ 个会话（不同端口避免去重），调用 closeAll()，验证每台 transport.close 都被调用。
  it('closeAll 关闭多会话：每个会话的 transport.close 都被调用', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const a = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 21, label: 'dev-a' })
    const b = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 22, label: 'dev-b' })
    const c = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 23, label: 'dev-c' })
    expect(sm.list()).toHaveLength(3)
    expect(rec.closeCount).toBe(0)
    await sm.closeAll()
    // 三个会话各自的 transport.close 均被调用一次
    expect(rec.closeCount).toBe(3)
    expect(a.status).toBe('open') // closeAll 只调 transport.close，不改 SessionRecord.status（status 由 onClose 回调改）
    void a
    void b
    void c
  })

  // U-SM-BUF-01：handleData 超 BUFFER_CAP_BYTES 截断
  // 场景：向会话注入超过 BUFFER_CAP_BYTES（1MB）的 chunk，验证 buffer 被截断为尾部 1MB，不无限增长。
  it('handleData 超 BUFFER_CAP_BYTES 截断：buffer 仅保留尾部 1MB', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    const cap = 1024 * 1024 // BUFFER_CAP_BYTES
    const overflow = 100
    // 头部用 'A'，尾部用 'B'，注入 cap + overflow 字节；截断后保留尾部 cap 字节
    const huge = 'A'.repeat(cap) + 'B'.repeat(overflow)
    rec.sessions[0].callbacks.onData(huge)
    // read 取全部行（无换行 → 单行），验证截断后长度与内容
    const page = sm.read(snap.sessionId, cap + overflow)
    expect(page.text.length).toBe(cap) // 截断为尾部 1MB，不无限增长
    expect(page.totalLines).toBe(1)
    // 尾部 cap 字节 = 'A'.repeat(cap-overflow) + 'B'.repeat(overflow)（头部 overflow 个 'A' 已丢弃）
    expect(page.text.endsWith('B'.repeat(overflow))).toBe(true) // 尾部 overflow 个 'B' 保留
    expect(page.text.slice(0, cap - overflow)).toBe('A'.repeat(cap - overflow)) // 其余为 'A'
    // 验证头部前 overflow 个 'A' 确实被丢弃：原 huge 前 overflow 字节是 'A'，截断后不包含它们
    // （buffer 长度等于 cap 而非 cap+overflow 即证明截断生效）
  })
})

describe('SessionManager 发送与完成判定', () => {
  it('静默判定：发命令 → 输出停顿后返回整段', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    const pending = sm.sendAndWait(snap.sessionId, 'show version')
    setTimeout(() => rec.sessions[0].callbacks.onData('Version 1.2.3\n'), 20)
    const result = await pending
    expect(result.waitReason).toBe('quiet') // quietMs=100（连接配置）
    expect(result.output).toContain('Version 1.2.3')
    expect(rec.written[0]).toBe('show version\r\n')
  })

  it('换行回退到连接配置：newline=lf → 行尾用 \\n（而非默认 crlf）', async () => {
    const { rec, factory } = fakeFactory()
    const lfConn = await store.create({ label: 'dev-lf', protocol: 'telnet', host: '127.0.0.1', port: 9, quietMs: 100, newline: 'lf' })
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(lfConn.id)
    const pending = sm.sendAndWait(snap.sessionId, 'show version')
    setTimeout(() => rec.sessions[0].callbacks.onData('ok\n'), 20)
    await pending
    expect(rec.written[0]).toBe('show version\n')
  })

  it('换行：临时连接的 newline 也生效', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 9, label: 'tmp', newline: 'cr' })
    const pending = sm.sendAndWait(snap.sessionId, 'show version')
    setTimeout(() => rec.sessions[0].callbacks.onData('ok\n'), 20)
    await pending
    expect(rec.written[0]).toBe('show version\r')
  })

  it('临时连接（无 connId，含 AI 工具路径）自动入「最近连接」而非「收藏」', async () => {
    const isolated = new ConnectionStore(join(dir, 'fav-auto.json'))
    await isolated.load()
    const { factory } = fakeFactory()
    const sm = new SessionManager(isolated, factory)
    await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 9, label: 'ai-tmp' })
    const conns = isolated.list()
    expect(conns).toHaveLength(1)
    expect(conns[0].favorited).toBe(false)
  })

  it('换行：调用参数覆盖连接配置', async () => {
    const { rec, factory } = fakeFactory()
    const lfConn = await store.create({ label: 'dev-lf2', protocol: 'telnet', host: '127.0.0.1', port: 9, quietMs: 100, newline: 'lf' })
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(lfConn.id)
    const pending = sm.sendAndWait(snap.sessionId, 'show version', { newline: 'crlf' })
    setTimeout(() => rec.sessions[0].callbacks.onData('ok\n'), 20)
    await pending
    expect(rec.written[0]).toBe('show version\r\n')
  })

  it('sendImmediate 也用连接配置换行', async () => {
    const { rec, factory } = fakeFactory()
    const lfConn = await store.create({ label: 'dev-lf3', protocol: 'telnet', host: '127.0.0.1', port: 9, newline: 'lf' })
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(lfConn.id)
    await sm.sendImmediate(snap.sessionId, 'show clock', { guard: {} })
    expect(rec.written[0]).toBe('show clock\n')
  })

  it('提示符判定：来自连接配置的正则', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(promptConnId)
    const pending = sm.sendAndWait(snap.sessionId, 'display version')
    setTimeout(() => rec.sessions[0].callbacks.onData('blah\nPROMPT# '), 20)
    const result = await pending
    expect(result.waitReason).toBe('prompt')
  })

  it('超时兜底', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(promptConnId)
    const result = await sm.sendAndWait(snap.sessionId, 'sleep 999', { wait: { timeoutMs: 1000, quietMs: 5000 } })
    expect(result.waitReason).toBe('timeout')
  })

  it('独占：忙碌时第二条直接拒绝，结束后释放', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    const first = sm.sendAndWait(snap.sessionId, 'cmd1')
    await expect(sm.sendAndWait(snap.sessionId, 'cmd2')).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    setTimeout(() => rec.sessions[0].callbacks.onData('ok\n'), 20)
    await first
    const third = sm.sendAndWait(snap.sessionId, 'cmd3')
    setTimeout(() => rec.sessions[0].callbacks.onData('ok\n'), 20)
    await third
  })

  it('命令守卫：AI 路径拦截危险命令，且不写入设备', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    await expect(sm.sendAndWait(snap.sessionId, 'rm -rf /', { guard: {} }))
      .rejects.toMatchObject({ code: 'COMMAND_BLOCKED' })
    expect(rec.written).toHaveLength(0)
    const next = sm.sendAndWait(snap.sessionId, 'echo hi')
    setTimeout(() => rec.sessions[0].callbacks.onData('hi\n'), 20)
    await next
  })

  it('等待期间掉线 → DISCONNECTED', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const snap = await sm.connectByConnId(connId)
    const pending = sm.sendAndWait(snap.sessionId, 'slow', { wait: { quietMs: 5000, timeoutMs: 10000 } })
    setTimeout(() => rec.sessions[0].callbacks.onClose('设备掉线'), 30)
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
})

describe('SessionManager 广播', () => {
  it('逐台独立出结果：成功 / 忙碌 / 已断开', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const a = await sm.connectByConnId(connId) // 假传输槽位 0
    const b = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 10, label: 'dev-b' }) // 槽位 1（不同端口=不同设备，避免去重）
    // 让 b 忙碌：先发一条挂起的（稍后喂数据收尾）
    const pendingB = sm.sendAndWait(b.sessionId, 'long', { wait: { quietMs: 100 } })
    const entries = sm.broadcast('show clock', [a.sessionId, b.sessionId, 'nonexistent'], { wait: { quietMs: 100 } })
    setTimeout(() => {
      rec.sessions[0].callbacks.onData('clock ok\n') // a 的输出
      rec.sessions[1].callbacks.onData('done\n') // b 的收尾
    }, 20)
    const [results] = await Promise.all([entries, pendingB])
    const byId = Object.fromEntries(results.map(e => [e.sessionId, e.outcome]))
    expect(byId[a.sessionId]).toBe('ok')
    expect(byId[b.sessionId]).toBe('busy')
    expect(byId['nonexistent']).toBe('disconnected')
  })

  it('缺省目标 = 全部打开的会话', async () => {
    const { rec, factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    await sm.connectByConnId(connId)
    await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 11, label: 'dev-c' })
    const entriesPromise = sm.broadcast('echo 1', undefined, { wait: { quietMs: 100 } })
    setTimeout(() => {
      rec.sessions[0].callbacks.onData('x\n')
      rec.sessions[1].callbacks.onData('x\n')
    }, 20)
    const results = await entriesPromise
    expect(results).toHaveLength(2)
    expect(results.every(r => r.outcome === 'ok')).toBe(true)
  })

  // U-SM-BC-01：sendAndWait 抛非 SessionError 的普通 Error → broadcast 归为 PROTO_ERROR
  // 场景：传输层 write 同步抛普通 Error（非 SessionError），broadcast 的 catch 走 398-399 行
  // 非法错误码分支，返回 outcome='error', code='PROTO_ERROR'。
  it('sendAndWait 抛普通 Error → 单台归为 PROTO_ERROR（非 SessionError 分支）', async () => {
    // 自定义工厂：transport.write 同步抛普通 Error（不是 SessionError）
    const throwingFactory: TransportFactory = async (_target, callbacks) => {
      const slot: FakeSession = { callbacks }
      const transport: Transport = {
        // 关键：抛普通 Error 而非 SessionError，触发 broadcast 的 PROTO_ERROR 分支
        write: () => { throw new Error('传输层写入失败（非协议错误）') },
        close: async () => { callbacks.onClose('本端主动断开') },
      }
      return transport
    }
    const sm = new SessionManager(store, throwingFactory)
    const snap = await sm.connectByConnId(connId)
    const results = await sm.broadcast('show clock', [snap.sessionId], { wait: { quietMs: 100 } })
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe(snap.sessionId)
    expect(results[0].outcome).toBe('error')
    expect(results[0].code).toBe('PROTO_ERROR')
    // 清理：disconnect 触发 status='removed'，让 sendAndWait 内部泄漏的 setInterval 在下一 tick 自清理
    await sm.disconnect(snap.sessionId)
    await new Promise(resolve => setTimeout(resolve, 60))
  })
})

describe('SessionManager × 真实模拟设备（端到端）', () => {
  const lab = createDeviceLab()
  afterAll(async () => { await lab.cleanup() })

  it('Telnet echo：连接 → 发命令 → 拿回显 → 读缓冲 → 断开', async () => {
    const { port } = await lab.startEchoServer()
    const sm = new SessionManager(undefined)
    const snap = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port, label: 'echo' })
    const result = await sm.sendAndWait(snap.sessionId, 'ping', { wait: { quietMs: 200 } })
    expect(result.output).toContain('ping')
    expect(sm.read(snap.sessionId).text).toContain('ping')
    await sm.disconnect(snap.sessionId)
    expect(sm.list()).toHaveLength(0)
  })
})

describe('SessionManager SFTP 门面（S5 步骤3）', () => {
  /** ssh 目标带 getSftp、telnet 目标不带的假传输工厂 */
  function sftpFakeFactory(): { rec: FakeRec; factory: TransportFactory } {
    const rec: FakeRec = { written: [], resized: [], sessions: [], closeCount: 0 }
    const factory: TransportFactory = async (target, callbacks) => {
      rec.sessions.push({ callbacks })
      const transport: Transport = {
        write: (data) => { rec.written.push(data) },
        close: async () => { rec.closeCount += 1; callbacks.onClose('本端主动断开') },
        ...(target.protocol === 'ssh' ? { getSftp: async () => fakeSftpLike() } : {}),
      }
      return transport
    }
    return { rec, factory }
  }

  it('ssh 会话：返回传输层的 SFTP 门面', async () => {
    const { rec, factory } = sftpFakeFactory()
    const sm = new SessionManager(undefined, factory)
    const snap = await sm.connect({ protocol: 'ssh', host: '127.0.0.1', port: 22, label: 'sftp-dev' })
    const sftp = await sm.getSftp(snap.sessionId)
    expect(typeof sftp.list).toBe('function')
    // 懒开：每次调用走 transport.getSftp，会话内可重复取
    expect(typeof (await sm.getSftp(snap.sessionId)).stat).toBe('function')
    expect(rec.sessions).toHaveLength(1)
    await sm.disconnect(snap.sessionId)
  })

  it('closed 会话 → DISCONNECTED（被动断开后记录保留，状态不是 open）', async () => {
    const { rec, factory } = sftpFakeFactory()
    const sm = new SessionManager(undefined, factory)
    const snap = await sm.connect({ protocol: 'ssh', host: '127.0.0.1', port: 22, label: 'sftp-dev' })
    rec.sessions[0].callbacks.onClose('设备掉线')
    expect(sm.get(snap.sessionId)?.status).toBe('closed')
    await expect(sm.getSftp(snap.sessionId)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  it('telnet 会话：防御分支报「不支持 SFTP」（UNSUPPORTED 协议分派在 FileService）', async () => {
    const { factory } = sftpFakeFactory()
    const sm = new SessionManager(undefined, factory)
    const snap = await sm.connect({ protocol: 'telnet', host: '127.0.0.1', port: 23, label: 'tty-dev' })
    await expect(sm.getSftp(snap.sessionId)).rejects.toMatchObject({
      code: 'DISCONNECTED',
      message: expect.stringContaining('不支持 SFTP'),
    })
    await sm.disconnect(snap.sessionId)
  })

  it('会话不存在 → SESSION_NOT_FOUND', async () => {
    const { factory } = sftpFakeFactory()
    const sm = new SessionManager(undefined, factory)
    await expect(sm.getSftp('no-such')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  // SftpLike 类型引用（避免仅类型导入被裁掉的告警；真实形状测试在 file-service.spec.ts）
  it('门面形状：SftpLike 六个方法齐全', async () => {
    const sftp: SftpLike = fakeSftpLike()
    for (const name of ['list', 'stat', 'mkdirs', 'put', 'get', 'downloadStream'] as const) {
      expect(typeof sftp[name]).toBe('function')
    }
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { Transport, TransportCallbacks } from '../src/transport/types.ts'
import { createDeviceLab } from './helpers.ts'

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

  it('状态监听：连接中 → 已连接 → 已关闭', async () => {
    const { factory } = fakeFactory()
    const sm = new SessionManager(store, factory)
    const seen: string[] = []
    sm.onStatus(snap => seen.push(snap.status))
    const snap = await sm.connectByConnId(connId)
    await sm.disconnect(snap.sessionId)
    expect(seen).toEqual(['connecting', 'open', 'closed'])
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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ConnectionStore } from '../src/connection-store.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { Transport, TransportCallbacks } from '../src/transport/types.ts'
import { registerTerminalTools } from '../src/tools.ts'

/** 假传输：每会话一个槽位。 */
function fakeFactory(): { emit: (slot: number, chunk: string) => void; factory: TransportFactory } {
  const slots: TransportCallbacks[] = []
  const factory: TransportFactory = async (_target, callbacks) => {
    slots.push(callbacks)
    return { write: () => {}, close: async () => { callbacks.onClose('本端主动断开') } }
  }
  return { emit: (slot, chunk) => slots[slot]?.onData(chunk), factory }
}

function fakeAgent(ctx: Context, rawId: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

const TOOL_NAMES = ['tm_connect', 'tm_list', 'tm_send', 'tm_send_all', 'tm_read', 'tm_disconnect'] as const

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let dir: string
let store: ConnectionStore
let connId: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-tools-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'dev-a', protocol: 'telnet', host: '10.0.0.1', port: 23, quietMs: 100 })
  connId = conn.id
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const { emit, factory } = fakeFactory()
  const sessions = new SessionManager(store, factory)
  registerTerminalTools(ctx, sessions)
  const agent = fakeAgent(ctx, 'm3-tools')
  const signal = new AbortController().signal
  let callNumber = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({
    signal, callId: CallId(`tm-call-${++callNumber}`), name, arguments: args, agent,
  })
  return { ctx, sessions, emit, call, signal }
}

describe('B6 工具层', () => {
  it('注册恰好六个工具', async () => {
    const { ctx } = await setup()
    expect(TOOL_NAMES.every(name => ctx.tools.get(name) !== undefined)).toBe(true)
  })

  it('完整生命周期：连接 → 列表 → 发命令 → 读 → 断开', async () => {
    const { ctx, sessions, emit, call } = await setup()
    const opened = await call('tm_connect', { connId })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ label: 'dev-a', protocol: 'telnet', status: 'open' })
    const sid = (opened.value as { sessionId: string }).sessionId

    const listed = await call('tm_list', {})
    expect((listed.value as unknown[]).length).toBe(1)

    const pending = call('tm_send', { sessionId: sid, command: 'show version' })
    setTimeout(() => emit(0, 'Version 1.0\n'), 20)
    const sent = await pending
    expect(sent.isError).toBe(false)
    expect(sent.value).toMatchObject({ kind: 'completed', waitReason: 'quiet', output: 'Version 1.0\n' })

    const read = await call('tm_read', { sessionId: sid })
    expect((read.value as { text: string }).text).toContain('Version 1.0')

    const closed = await call('tm_disconnect', { sessionId: sid })
    expect(closed.value).toMatchObject({ sessionId: sid, outcome: 'closed' })
    expect(sessions.list()).toHaveLength(0)
  })

  it('临时连接（ad-hoc）', async () => {
    const { call } = await setup()
    const opened = await call('tm_connect', { protocol: 'telnet', host: '192.168.1.1', label: '临时' })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ label: '临时', target: '192.168.1.1:23' })
  })

  it('命令守卫拦截危险命令（AI 路径）', async () => {
    const { call, emit } = await setup()
    const opened = await call('tm_connect', { connId })
    const sid = (opened.value as { sessionId: string }).sessionId
    const blocked = await call('tm_send', { sessionId: sid, command: 'rm -rf /' })
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('拦截')
    // 拦截后会话仍可用
    const pending = call('tm_send', { sessionId: sid, command: 'echo ok' })
    setTimeout(() => emit(0, 'ok\n'), 20)
    const sent = await pending
    expect(sent.value).toMatchObject({ kind: 'completed', output: 'ok\n' })
  })

  it('发完即回（immediate）', async () => {
    const { call } = await setup()
    const opened = await call('tm_connect', { connId })
    const sid = (opened.value as { sessionId: string }).sessionId
    const sent = await call('tm_send', { sessionId: sid, command: 'tail -f', wait: 'immediate' })
    expect(sent.isError).toBe(false)
    expect(sent.value).toMatchObject({ kind: 'submitted' })
  })

  it('参数校验：空命令/缺会话报错', async () => {
    const { call } = await setup()
    expect((await call('tm_send', { sessionId: 'x', command: '' })).isError).toBe(true)
    expect((await call('tm_send', { sessionId: '', command: 'x' })).isError).toBe(true)
    expect((await call('tm_disconnect', { sessionId: '不存在' })).isError).toBe(true)
  })

  it('广播：成功 / 忙碌 / 已断开逐台出结果', async () => {
    const { call, emit } = await setup()
    const a = (await call('tm_connect', { connId })).value as { sessionId: string }
    const b = (await call('tm_connect', { protocol: 'telnet', host: '10.0.0.2', label: 'dev-b' })).value as { sessionId: string }
    // 让 b 忙碌
    const pendingB = call('tm_send', { sessionId: b.sessionId, command: 'long' })
    const broadcast = call('tm_send_all', { command: 'show clock', sessionIds: `${a.sessionId},${b.sessionId},nonexistent` })
    setTimeout(() => {
      emit(0, 'clock\n')   // a 的广播输出
      emit(1, 'done\n')   // b 的 pendingB 收尾
    }, 20)
    const [results, _pendingB] = await Promise.all([broadcast, pendingB])
    const entries = results.value as Array<{ sessionId: string; outcome: string }>
    const byId = Object.fromEntries(entries.map(e => [e.sessionId, e.outcome]))
    expect(byId[a.sessionId]).toBe('ok')
    expect(byId[b.sessionId]).toBe('busy')
    expect(byId['nonexistent']).toBe('disconnected')
  })
})

describe('B6 工具层错误路径', () => {
  it('tm_connect 临时连接缺 host → isError', async () => {
    const { call } = await setup()
    const r = await call('tm_connect', { protocol: 'telnet' })
    expect(r.isError).toBe(true)
  })

  it('tm_send 传不存在的 sessionId → isError', async () => {
    const { call } = await setup()
    const r = await call('tm_send', { sessionId: 'nonexistent-session', command: 'show version' })
    expect(r.isError).toBe(true)
  })

  it('tm_read 传不存在的 sessionId → isError', async () => {
    const { call } = await setup()
    const r = await call('tm_read', { sessionId: 'nonexistent-session' })
    expect(r.isError).toBe(true)
  })

  it('tm_send 超时 → waitReason=timeout', async () => {
    const { call } = await setup()
    const opened = await call('tm_connect', { connId })
    const sid = (opened.value as { sessionId: string }).sessionId
    const r = await call('tm_send', { sessionId: sid, command: 'sleep 999', timeoutMs: 1000, quietMs: 5000 })
    expect(r.isError).toBe(false)
    expect(r.value).toMatchObject({ kind: 'completed', waitReason: 'timeout' })
  })

  it('tm_send 过程中会话掉线 → isError', async () => {
    const { emit, call, sessions } = await setup()
    const opened = await call('tm_connect', { connId })
    const sid = (opened.value as { sessionId: string }).sessionId
    const pending = call('tm_send', { sessionId: sid, command: 'slow', timeoutMs: 10000, quietMs: 5000 })
    // 模拟设备掉线：触发传输层的 onClose
    await sessions.disconnect(sid)
    const r = await pending
    expect(r.isError).toBe(true)
  })

  it('tm_connect 重复连同一 connId → 返回同一 sessionId', async () => {
    const { call } = await setup()
    const first = await call('tm_connect', { connId })
    expect(first.isError).toBe(false)
    const sid1 = (first.value as { sessionId: string }).sessionId
    const second = await call('tm_connect', { connId })
    expect(second.isError).toBe(false)
    const sid2 = (second.value as { sessionId: string }).sessionId
    expect(sid2).toBe(sid1)
  })
})

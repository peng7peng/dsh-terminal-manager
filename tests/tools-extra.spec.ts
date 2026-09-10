/**
 * B6 工具层补充：immediate 分支、参数校验、sessionIds 解析、presentCall / presentResult 卡片；
 * S5：tm_upload / tm_download。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ConnectionStore } from '../src/connection-store.ts'
import { LocalFileService } from '../src/file-service.ts'
import { connectSsh } from '../src/transport/ssh.ts'
import type { SftpLike, Transport, TransportCallbacks } from '../src/transport/types.ts'
import type { FileService } from '../src/types/file-service.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import { registerTerminalTools } from '../src/tools.ts'
import { createLocalPanelState } from '../src/local-panel-state.ts'
import { createDeviceLab } from './helpers.ts'

function fakeFactory(): { emit: (slot: number, chunk: string) => void; written: string[]; factory: TransportFactory } {
  const slots: TransportCallbacks[] = []
  const written: string[] = []
  const factory: TransportFactory = async (_target, callbacks) => {
    slots.push(callbacks)
    return { write: (d) => { written.push(d) }, close: async () => { callbacks.onClose('本端主动断开') } }
  }
  return { emit: (slot, chunk) => slots[slot]?.onData(chunk), written, factory }
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

let dir: string
let store: ConnectionStore
let connId: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-tools-extra-'))
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
  const conn = await store.create({ label: 'saved-a', protocol: 'telnet', host: '10.0.0.7', port: 23, quietMs: 100 })
  connId = conn.id
})

afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup(opts: { files?: FileService; workspaceRoot?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const { emit, written, factory } = fakeFactory()
  const sessions = new SessionManager(store, factory)
  registerTerminalTools(ctx, {
    sessions,
    files: opts.files ?? new LocalFileService(),
    workspaceRoot: opts.workspaceRoot ?? dir,
    localPanel: createLocalPanelState(),
  })
  const agent = fakeAgent(ctx, 'tools-extra')
  const signal = new AbortController().signal
  let n = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`x-${++n}`), name, arguments: args, agent })
  const tool = (name: string) => ctx.tools.get(name) as unknown as {
    presentCall?: (args: unknown) => unknown
    presentResult?: (args: unknown, result: { isError: boolean; content: Array<{ type: string; text?: string }> }) => unknown
  }
  return { ctx, sessions, emit, written, call, tool }
}

describe('tm_connect 参数与匹配', () => {
  it('缺 protocol / 缺 host / SSH 缺 username → 报错', async () => {
    const { call } = await setup()
    expect((await call('tm_connect', {})).isError).toBe(true)
    expect((await call('tm_connect', { protocol: 'telnet' })).isError).toBe(true)
    expect((await call('tm_connect', { protocol: 'ssh', host: '10.0.0.8' })).isError).toBe(true)
  })
  it('临时参数命中已保存连接（host:port 相同）→ 复用该连接，不新建', async () => {
    const { call, sessions } = await setup()
    const r = await call('tm_connect', { protocol: 'telnet', host: '10.0.0.7', port: 23 })
    expect(r.isError).toBe(false)
    expect(r.value).toMatchObject({ label: 'saved-a', connId })
    expect(sessions.list()).toHaveLength(1)
  })
  it('presentCall 标题优先 label，其次 host，其次 connId', async () => {
    const { tool } = await setup()
    const pc = tool('tm_connect').presentCall!
    expect(pc({ label: 'L', host: 'h' })).toMatchObject({ title: '连接设备 L' })
    expect(pc({ host: 'h' })).toMatchObject({ title: '连接设备 h' })
    expect(pc({ connId: 'c' })).toMatchObject({ title: '连接设备 c' })
    expect(pc({})).toMatchObject({ title: '连接设备 ' })
  })
})

describe('tm_send / tm_send_all 分支', () => {
  it('wait=immediate：发完即回 submitted，写入带换行；空命令报错', async () => {
    const { call, written } = await setup()
    const sid = (await call('tm_connect', { connId })).value as { sessionId: string }
    const r = await call('tm_send', { sessionId: sid.sessionId, command: 'uptime', wait: 'immediate' })
    expect(r.isError).toBe(false)
    expect(r.value).toEqual({ kind: 'submitted' })
    expect(written.at(-1)).toBe('uptime\r\n')
    expect((await call('tm_send', { sessionId: sid.sessionId, command: '' })).isError).toBe(true)
  })
  it('presentCall / presentResult：终端卡片；immediate 或出错时不出结果卡', async () => {
    const { tool } = await setup()
    const t = tool('tm_send')
    expect(t.presentCall!({ sessionId: 's1', command: 'ls' })).toMatchObject({ card: 'terminal', title: 'ls', description: '会话 s1' })
    const a = { sessionId: 's1', command: 'ls' }
    expect(t.presentResult!({ ...a, wait: 'immediate' }, { isError: false, content: [{ type: 'text', text: 'x' }] })).toBeUndefined()
    expect(t.presentResult!(a, { isError: true, content: [] })).toBeUndefined()
    expect(t.presentResult!(a, { isError: false, content: [] })).toBeUndefined()
    expect(t.presentResult!(a, { isError: false, content: [{ type: 'text', text: 'out' }] })).toEqual({ card: 'terminal', output: 'out' })
  })
  it('tm_send_all：sessionIds 逗号分隔（含空格 / 空项）；immediate 分支对不存在的会话给 error 项', async () => {
    const { call, written } = await setup()
    const sid = ((await call('tm_connect', { connId })).value as { sessionId: string }).sessionId
    const r = await call('tm_send_all', { command: 'show ver', sessionIds: ` ${sid} , nope ,, `, wait: 'immediate' })
    expect(r.isError).toBe(false)
    expect(r.value).toEqual([
      { sessionId: sid, outcome: 'ok' },
      { sessionId: 'nope', outcome: 'error', code: 'SESSION_NOT_FOUND' },
    ])
    expect(written.at(-1)).toBe('show ver\r\n')
    expect((await call('tm_send_all', { command: '' })).isError).toBe(true)
  })
  it('tm_send_all 不传 sessionIds 且 immediate → 发给全部 open 会话', async () => {
    const { call } = await setup()
    await call('tm_connect', { connId })
    await call('tm_connect', { protocol: 'telnet', host: '10.0.0.9', port: 23 })
    const r = await call('tm_send_all', { command: 'uptime', wait: 'immediate' })
    expect((r.value as unknown[]).length).toBe(2)
    expect(tool_present(r)).toBe(true)
  })
  it('tm_send_all 等待模式 + quietMs/timeoutMs 覆盖 → 展平 output / waitReason', async () => {
    const { call, emit } = await setup()
    const sid = ((await call('tm_connect', { connId })).value as { sessionId: string }).sessionId
    const p = call('tm_send_all', { command: 'date', sessionIds: sid, quietMs: 100, timeoutMs: 2000 })
    setTimeout(() => emit(0, 'Tue\n'), 30)
    const r = await p
    expect(r.value).toEqual([{ sessionId: sid, outcome: 'ok', output: 'Tue\n', waitReason: 'quiet' }])
  })
  it('tm_read 的 count 生效；tm_list / tm_read / tm_disconnect / tm_send_all 的 presentCall', async () => {
    const { call, emit, tool } = await setup()
    const sid = ((await call('tm_connect', { connId })).value as { sessionId: string }).sessionId
    emit(0, 'l1\nl2\nl3\n')
    const r = await call('tm_read', { sessionId: sid, count: 2 })
    expect(r.value).toMatchObject({ truncated: true })
    expect(tool('tm_list').presentCall!({})).toMatchObject({ title: '列出会话', kind: 'read' })
    expect(tool('tm_read').presentCall!({ sessionId: 's' })).toMatchObject({ title: '读取会话 s' })
    expect(tool('tm_disconnect').presentCall!({ sessionId: 's' })).toMatchObject({ title: '断开会话 s', kind: 'delete' })
    expect(tool('tm_send_all').presentCall!({ command: 'c' })).toMatchObject({ title: '广播命令：c' })
  })
})

function tool_present(r: { isError: boolean }): boolean { return !r.isError }

describe('tm_upload / tm_download（S5）', () => {
  const lab = createDeviceLab()
  let transport: Transport | undefined
  const roots: string[] = []

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    await lab.cleanup()
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
  })

  /** 起一个 mock SFTP 设备 + 指向它的文件服务；wsRoot 为工作区树根（Telnet 模式不起设备，测 UNSUPPORTED 分派） */
  const mkFiles = async (protocol: 'ssh' | 'telnet' = 'ssh'): Promise<{ files: FileService; devRoot: string; wsRoot: string }> => {
    const devRoot = await mkdtemp(join(tmpdir(), 'tm-tl-dev-'))
    const wsRoot = await mkdtemp(join(tmpdir(), 'tm-tl-ws-'))
    roots.push(devRoot, wsRoot)
    let sftp: SftpLike | undefined
    if (protocol === 'ssh') {
      const { port } = await lab.startSftpDevice(devRoot)
      transport = await connectSsh({ host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } }, { onData: () => {}, onClose: () => {} })
      sftp = await transport.getSftp!()
    }
    return {
      files: new LocalFileService({ get: () => ({ sessionId: 'gw', label: 'd', target: 't', protocol, status: 'open' }), getSftp: async () => sftp! }),
      devRoot,
      wsRoot,
    }
  }

  it('缺参数 → 报错（不触文件服务）', async () => {
    const { call } = await setup()
    expect((await call('tm_upload', { sessionId: 's' })).isError).toBe(true)
    expect((await call('tm_upload', { sessionId: 's', localPath: 'C:/x' })).isError).toBe(true)
    expect((await call('tm_download', { sessionId: 's', remotePath: '/x' })).isError).toBe(true)
  })

  it('tm_upload：工作区内文件上传成功（mock SFTP 设备落位）；presentCall 标题', async () => {
    const { files, devRoot, wsRoot } = await mkFiles()
    const { call, tool } = await setup({ files, workspaceRoot: wsRoot })
    await writeFile(join(wsRoot, 'a.txt'), 'upload-me')
    const r = await call('tm_upload', { sessionId: 'any', localPath: join(wsRoot, 'a.txt'), remotePath: '/up-a.txt' })
    expect(r.isError).toBe(false)
    expect(r.value).toMatchObject({ ok: true, bytes: 9 })
    expect(await readFile(join(devRoot, 'up-a.txt'), 'utf8')).toBe('upload-me')
    expect(tool('tm_upload').presentCall!({ sessionId: 's', localPath: 'C:/ws/a.txt', remotePath: '/a.txt' })).toMatchObject({ title: '上传 C:/ws/a.txt → /a.txt', kind: 'execute' })
  })

  it('tm_upload 树根外 → PATH_OUTSIDE_ROOT；Telnet 会话 → UNSUPPORTED（码折叠进 message）', async () => {
    const { files, wsRoot } = await mkFiles()
    const outside = await mkdtemp(join(tmpdir(), 'tm-tl-out-'))
    roots.push(outside)
    const { call } = await setup({ files, workspaceRoot: wsRoot })
    await writeFile(join(outside, 'f.txt'), 'x')
    const r = await call('tm_upload', { sessionId: 'any', localPath: join(outside, 'f.txt'), remotePath: '/x' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('PATH_OUTSIDE_ROOT')

    const telnet = (await mkFiles('telnet')).files
    const { call: call2 } = await setup({ files: telnet, workspaceRoot: wsRoot })
    await writeFile(join(wsRoot, 't.txt'), 'y')
    const r2 = await call2('tm_upload', { sessionId: 'any', localPath: join(wsRoot, 't.txt'), remotePath: '/t.txt' })
    expect(r2.isError).toBe(true)
    expect(JSON.stringify(r2)).toContain('UNSUPPORTED')
  })

  it('tm_download：落到工作区、返回字节数；presentCall 标题', async () => {
    const { files, devRoot, wsRoot } = await mkFiles()
    const { call, tool } = await setup({ files, workspaceRoot: wsRoot })
    await writeFile(join(devRoot, 'dl-t.txt'), 'device-data')
    const r = await call('tm_download', { sessionId: 'any', remotePath: '/dl-t.txt', localPath: join(wsRoot, 'out.txt') })
    expect(r.isError).toBe(false)
    expect(r.value).toMatchObject({ ok: true, bytes: 11 })
    expect(await readFile(join(wsRoot, 'out.txt'), 'utf8')).toBe('device-data')
    expect(tool('tm_download').presentCall!({ sessionId: 's', remotePath: '/a', localPath: 'C:/ws/a' })).toMatchObject({ title: '下载 /a → C:/ws/a', kind: 'execute' })
  })
})

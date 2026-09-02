/**
 * B7a 新端点：files.tree / read / write / dirs / root 与 sessions.send。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { LocalFileService } from '../src/file-service.ts'
import { dispatch, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import type { TransportCallbacks } from '../src/transport/types.ts'
import type { TmEvent } from '../src/types/events.ts'

let dir: string
let root: string
let store: ConnectionStore

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-rf-'))
  root = join(dir, 'ws')
  await mkdir(root)
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'case1.txt'), '##>0\nls\n')
  store = new ConnectionStore(join(dir, 'connections.json'))
  await store.load()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeFactory(): { slots: TransportCallbacks[]; written: string[]; factory: TransportFactory } {
  const slots: TransportCallbacks[] = []
  const written: string[] = []
  const factory: TransportFactory = async (_t, callbacks) => {
    slots.push(callbacks)
    return { write: (d) => { written.push(d) }, close: async () => { callbacks.onClose('bye') } }
  }
  return { slots, written, factory }
}

function makeDeps(withFiles = true): { deps: RemoteDeps; slots: TransportCallbacks[]; written: string[] } {
  const { slots, written, factory } = fakeFactory()
  const sessions = new SessionManager(store, factory)
  const deps: RemoteDeps = {
    sessions, store,
    config: { workspaceRoot: root, telnetFileTransfer: true },
    ...(withFiles ? { files: new LocalFileService() } : {}),
  }
  return { deps, slots, written }
}

const abort = new AbortController().signal
/** dispatch 先 await 存储加载再订阅输出——喂输出前要等一个 tick，否则输出在订阅前就丢了（等到超时） */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))
const value = <T,>(r: unknown): T => (r as { value: T }).value
const errMsg = (r: unknown): string => (r as { error: { message: string } }).error.message

describe('files.* 端点', () => {
  it('files.root 返回配置的树根', async () => {
    const { deps } = makeDeps()
    expect(value(await dispatch('files.root', {}, deps, abort))).toEqual({ root })
  })
  it('files.tree 列目录', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('files.tree', { root, path: root }, deps, abort)
    expect(r.ok).toBe(true)
    expect(value<{ name: string }[]>(r).map(e => e.name)).toEqual(['sub', 'case1.txt'])
  })
  it('files.read / files.write 往返；maxBytes 生效', async () => {
    const { deps } = makeDeps()
    const w = await dispatch('files.write', { root, path: join(root, 'new.md'), content: '# hi' }, deps, abort)
    expect(value(w)).toEqual({ bytes: 4 })
    const r = await dispatch('files.read', { root, path: join(root, 'new.md') }, deps, abort)
    expect(value(r)).toEqual({ content: '# hi', size: 4, truncated: false })
    const t = await dispatch('files.read', { root, path: join(root, 'new.md'), maxBytes: 1 }, deps, abort)
    expect(value(t)).toEqual({ content: '#', size: 4, truncated: true })
  })
  it('files.dirs 只列子目录', async () => {
    const { deps } = makeDeps()
    expect(value<{ name: string }[]>(await dispatch('files.dirs', { path: root }, deps, abort)).map(e => e.name)).toEqual(['sub'])
  })
  it('越界 → 错误码 PATH_OUTSIDE_ROOT 编进 message', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('files.read', { root, path: join(dir, 'connections.json') }, deps, abort)
    expect(r.ok).toBe(false)
    expect(errMsg(r)).toMatch(/^PATH_OUTSIDE_ROOT:/)
  })
  it('content 不是字符串 → VALIDATION', async () => {
    const { deps } = makeDeps()
    const r = await dispatch('files.write', { root, path: join(root, 'x.txt'), content: 123 }, deps, abort)
    expect(errMsg(r)).toMatch(/^VALIDATION:/)
  })
  it('未注入文件服务 → UNSUPPORTED', async () => {
    const { deps } = makeDeps(false)
    expect(errMsg(await dispatch('files.tree', { root, path: root }, deps, abort))).toMatch(/^UNSUPPORTED:/)
  })

  it('files.open：树根内的文件交给注入的打开函数；目录 → VALIDATION；根外 → PATH_OUTSIDE_ROOT；未注入 → UNSUPPORTED', async () => {
    const { deps } = makeDeps()
    const opened: string[] = []
    deps.openExternal = async (p) => { opened.push(p) }
    const r = await dispatch('files.open', { root, path: join(root, 'case1.txt') }, deps, abort)
    expect(r.ok).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.toLowerCase()).toContain('case1.txt')
    expect(errMsg(await dispatch('files.open', { root, path: join(root, 'sub') }, deps, abort))).toMatch(/^VALIDATION:/)
    expect(errMsg(await dispatch('files.open', { root, path: join(dir, 'connections.json') }, deps, abort))).toMatch(/^PATH_OUTSIDE_ROOT:/)
    expect(opened).toHaveLength(1)
    delete deps.openExternal
    expect(errMsg(await dispatch('files.open', { root, path: join(root, 'case1.txt') }, deps, abort))).toMatch(/^UNSUPPORTED:/)
  })
})

describe('sessions.send 端点', () => {
  it('一次 sendAndWait：返回 SendResult，input 事件来源缺省 script', async () => {
    const { deps, slots, written } = makeDeps()
    const seen: TmEvent[] = []
    deps.sessions.events.on(e => seen.push(e), { type: 'input' })
    const snap = value<{ sessionId: string }>(await dispatch('sessions.connect', { protocol: 'telnet', host: '10.0.0.9', port: 23 }, deps, abort))
    const p = dispatch('sessions.send', { sessionId: snap.sessionId, command: 'ls', wait: { quietMs: 100, timeoutMs: 2000 } }, deps, abort)
    await tick()
    slots[0]?.onData('ls\r\nfile\r\nrouter> ')
    const r = value<{ output: string; waitReason: string }>(await p)
    expect(r.output).toContain('file')
    expect(written).toEqual(['ls\r\n'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type === 'input' && seen[0].source).toBe('script')
  })
  it('显式 source 与 newline 透传；会话不存在 → SESSION_NOT_FOUND', async () => {
    const { deps, slots, written } = makeDeps()
    const seen: TmEvent[] = []
    deps.sessions.events.on(e => seen.push(e), { type: 'input' })
    const snap = value<{ sessionId: string }>(await dispatch('sessions.connect', { protocol: 'telnet', host: '10.0.0.10', port: 23 }, deps, abort))
    const p = dispatch('sessions.send', { sessionId: snap.sessionId, command: 'pwd', source: 'human', newline: 'lf', wait: { quietMs: 100, timeoutMs: 2000 } }, deps, abort)
    await tick()
    slots[0]?.onData('/\r\nrouter> ')
    await p
    expect(written).toEqual(['pwd\n'])
    expect(seen[0]?.type === 'input' && seen[0].source).toBe('human')
    expect(errMsg(await dispatch('sessions.send', { sessionId: 'nope', command: 'x' }, deps, abort))).toMatch(/^SESSION_NOT_FOUND:/)
  })
})

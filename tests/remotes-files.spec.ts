/**
 * B7a 新端点：files.tree / read / write / dirs / root 与 sessions.send；
 * S5 传输：files.remoteTree / files.downloadToLocal RPC + HTTP /files/upload、/files/download 路由。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import { LocalFileService } from '../src/file-service.ts'
import { createHttpHandler, dispatch, type RemoteDeps } from '../src/remotes.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'
import { connectSsh } from '../src/transport/ssh.ts'
import type { Transport, TransportCallbacks } from '../src/transport/types.ts'
import type { FileProgressFrame } from '../src/ws-io.ts'
import type { TmEvent } from '../src/types/events.ts'
import { createDeviceLab } from './helpers.ts'

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
    config: { workspaceRoot: root },
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

describe('sessions.reconnect / 取消', () => {
  it('被动断开后 sessions.reconnect 重建连接，sessionId 不变', async () => {
    const { deps, slots } = makeDeps()
    const snap = value<{ sessionId: string }>(await dispatch('sessions.connect', { protocol: 'telnet', host: '10.0.0.11', port: 23 }, deps, abort))
    slots[0]?.onClose('设备掉线')
    expect(deps.sessions.get(snap.sessionId)?.status).toBe('closed')
    const r = value<{ sessionId: string; status: string }>(await dispatch('sessions.reconnect', { sessionId: snap.sessionId }, deps, abort))
    expect(r).toMatchObject({ sessionId: snap.sessionId, status: 'open' })
  })
  it('signal 已取消时出错 → cancelled', async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    ac.abort()
    const r = await dispatch('sessions.disconnect', { sessionId: 'nope' }, deps, ac.signal)
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe('cancelled')
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

describe('S5 传输（RPC + HTTP 路由，挂 mock SFTP 设备）', () => {
  const lab = createDeviceLab()
  const SESSION = 'sess-route'
  let dir: string
  let root: string
  let devRoot: string
  let store: ConnectionStore
  let transport: Transport | undefined
  let deps: RemoteDeps
  let frames: FileProgressFrame[]
  let handler: ReturnType<typeof createHttpHandler>

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-s5-route-'))
    root = join(dir, 'ws')
    devRoot = join(dir, 'dev')
    await mkdir(root)
    await mkdir(devRoot)
    store = new ConnectionStore(join(dir, 'connections.json'))
    await store.load()
    const { port } = await lab.startSftpDevice(devRoot)
    transport = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: () => {}, onClose: () => {} })
    const sftp = await transport.getSftp!()
    frames = []
    deps = {
      sessions: new SessionManager(store, fakeFactory()),
      store,
      files: new LocalFileService(
        { get: () => ({ sessionId: SESSION, label: 'dev', target: '127.0.0.1', protocol: 'ssh', status: 'open' }), getSftp: async () => sftp },
      ),
      broadcastFileProgress: (f) => frames.push(f),
    }
    handler = createHttpHandler(deps)
  })

  afterAll(async () => {
    await transport?.close()
    await lab.cleanup()
    await rm(dir, { recursive: true, force: true })
  })

  /** 假 req：body 作为 raw 流（upload 直传用） */
  function fakeReq(method: string, url: string, body?: string) {
    const readable = Readable.from(body !== undefined ? [Buffer.from(body)] : [])
    return Object.assign(readable, { method, url, headers: { host: '127.0.0.1:3180' } })
  }

  /** 假 res：JSON 响应用（只记录 writeHead/end） */
  function fakeRes() {
    const calls: { statusCode: number; headers: Record<string, string> }[] = []
    let ended = ''
    return {
      writeHead(statusCode: number, headers?: Record<string, string>) { calls.push({ statusCode, headers: headers ?? {} }) },
      end(data?: string) { ended = data ?? '' },
      _calls: calls,
      _json: () => JSON.parse(ended) as Record<string, unknown>,
    }
  }

  /** 假 res：流式响应用（真 Writable，收内容 + 记 writeHead） */
  function fakeStreamRes() {
    const calls: { statusCode: number; headers: Record<string, string> }[] = []
    const chunks: Buffer[] = []
    const res = new PassThrough()
    res.on('data', (c: Buffer) => chunks.push(c))
    return Object.assign(res, {
      writeHead(statusCode: number, headers?: Record<string, string>) { calls.push({ statusCode, headers: headers ?? {} }) },
      _calls: calls,
      _bytes: () => Buffer.concat(chunks),
      _headers: () => calls[0]?.headers ?? {},
    })
  }

  it('RPC files.remoteTree：远端列表（目录在前、不分大小写）', async () => {
    await mkdir(join(devRoot, 'rdir'))
    await writeFile(join(devRoot, 'rb.txt'), '0123456789')
    const r = await dispatch('files.remoteTree', { sessionId: SESSION, path: '/' }, deps, abort)
    expect(r.ok).toBe(true)
    expect(value<{ name: string }[]>(r).map(e => e.name)).toEqual(['rdir', 'rb.txt'])
  })

  it('RPC files.downloadToLocal：落到工作区、返回 transferId、终态帧 ok', async () => {
    await writeFile(join(devRoot, 'dl.txt'), 'rpc-download')
    const r = await dispatch('files.downloadToLocal', { sessionId: SESSION, remotePath: '/dl.txt', root, path: join(root, 'dl.txt'), transferId: 'r1' }, deps, abort)
    expect(r.ok).toBe(true)
    expect(value<{ transferId: string; bytes: number }>(r)).toMatchObject({ transferId: 'r1', bytes: 12 })
    expect(await readFile(join(root, 'dl.txt'), 'utf8')).toBe('rpc-download')
    expect(frames.filter((f) => f.transferId === 'r1').at(-1)).toMatchObject({ transferId: 'r1', done: true, ok: true })
  })

  it('RPC files.downloadToLocal transferId 超 64 → VALIDATION', async () => {
    const r = await dispatch('files.downloadToLocal', { sessionId: SESSION, remotePath: '/dl.txt', root, path: join(root, 'x'), transferId: 'x'.repeat(65) }, deps, abort)
    expect(r.ok).toBe(false)
    expect(errMsg(r)).toMatch(/^VALIDATION:/)
  })

  it('POST /files/upload（raw body）：直传落设备、value 带字节与 transferId、进度帧 + 终态帧', async () => {
    const res = fakeRes()
    await handler(fakeReq('POST', `/term-manager/files/upload?sessionId=${SESSION}&remotePath=%2Fup.txt&transferId=t1`, 'hello upload') as never, res as never)
    expect(res._calls[0]?.statusCode).toBe(200)
    expect((res._json() as { value: { bytes: number; transferId: string; ok: boolean } }).value).toMatchObject({ bytes: 12, transferId: 't1', ok: true })
    expect(await readFile(join(devRoot, 'up.txt'), 'utf8')).toBe('hello upload')
    const t1 = frames.filter((f) => f.transferId === 't1')
    expect(t1.length).toBeGreaterThanOrEqual(2)
    expect(t1[0]).toMatchObject({ kind: 'file-progress', transferId: 't1', op: 'upload' })
    expect(t1.at(-1)).toMatchObject({ transferId: 't1', op: 'upload', done: true, ok: true, transferred: 12 })
  })

  it('POST /files/upload 缺 sessionId → 400 VALIDATION；终态帧 ok:false', async () => {
    const res = fakeRes()
    await handler(fakeReq('POST', '/term-manager/files/upload?remotePath=%2Fx&transferId=t2', 'data') as never, res as never)
    expect(res._calls[0]?.statusCode).toBe(400)
    expect((res._json() as { error: { message: string } }).error.message).toContain('VALIDATION')
    expect(frames.filter((f) => f.transferId === 't2').at(-1)).toMatchObject({ transferId: 't2', done: true, ok: false })
  })

  it('GET /files/download：RFC 5987 文件名、no-store、content-length、内容一致、终态帧 ok', async () => {
    const content = 'download-content-中文'
    await writeFile(join(devRoot, '中文 报告.txt'), content)
    const res = fakeStreamRes()
    await handler(fakeReq('GET', `/term-manager/files/download?sessionId=${SESSION}&remotePath=${encodeURIComponent('/中文 报告.txt')}&transferId=d1`) as never, res as never)
    const headers = res._headers()
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('中文 报告.txt')}`)
    expect(headers['content-disposition']).toContain('filename="__ __.txt"')
    expect(headers['content-length']).toBe(String(Buffer.byteLength(content)))
    expect(res._bytes().toString('utf8')).toBe(content)
    expect(frames.filter((f) => f.transferId === 'd1').at(-1)).toMatchObject({ transferId: 'd1', done: true, ok: true })
  })

  it('GET /files/download 文件不存在 → 404 JSON（头未发）、终态帧 ok:false', async () => {
    const res = fakeStreamRes()
    await handler(fakeReq('GET', `/term-manager/files/download?sessionId=${SESSION}&remotePath=%2Fnope.bin&transferId=d2`) as never, res as never)
    expect(res._calls[0]?.statusCode).toBe(404)
    expect((JSON.parse(res._bytes().toString('utf8')) as { ok: boolean }).ok).toBe(false)
    expect(frames.filter((f) => f.transferId === 'd2').at(-1)).toMatchObject({ transferId: 'd2', done: true, ok: false })
  })

  it('方法不对 → 405（GET /files/upload、POST /files/download）', async () => {
    const a = fakeRes()
    await handler(fakeReq('GET', '/term-manager/files/upload') as never, a as never)
    expect(a._calls[0]?.statusCode).toBe(405)
    const b = fakeRes()
    await handler(fakeReq('POST', '/term-manager/files/download') as never, b as never)
    expect(b._calls[0]?.statusCode).toBe(405)
  })
})

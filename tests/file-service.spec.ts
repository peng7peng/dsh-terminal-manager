/**
 * B10 文件服务本地四件套：在临时目录里跑，不碰用户文件。
 */
// 仅对 rename/unlink 做可控包装（默认透传真实实现），供 U-FS-WL-01 模拟 rename 失败 + 验证 unlink 清理。
// 其余 fs 方法直接透传，不影响现有 32 个测试。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    readFile: vi.fn(actual.readFile),
  }
})
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../src/event-bus.ts'
import { FileServiceError } from '../src/file-errors.ts'
import type { FileSessionGateway } from '../src/file-service.ts'
import { LocalFileService } from '../src/file-service.ts'
import { connectSsh } from '../src/transport/ssh.ts'
import { TransportError, type Transport } from '../src/transport/types.ts'
import type { SessionSnapshot } from '../src/types/session-api.ts'
import type { TmEvent } from '../src/types/events.ts'
import type { TransferProgress } from '../src/types/file-service.ts'
import { createDeviceLab, fakeSftpLike } from './helpers.ts'

let root: string
let outside: string
const svc = new LocalFileService()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-fs-root-'))
  outside = await mkdtemp(join(tmpdir(), 'tm-fs-outside-'))
  await mkdir(join(root, 'zdir'))
  await mkdir(join(root, 'Adir'))
  await writeFile(join(root, 'b.txt'), 'hello world')
  await writeFile(join(root, 'a.md'), '# t')
  await writeFile(join(root, 'zdir', 'inner.py'), 'print(1)')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK' } catch (e) { return e instanceof FileServiceError ? e.code : `OTHER:${String(e)}` }
}

describe('listLocal', () => {
  it('目录在前、名字不分大小写排序、文件带 size', async () => {
    const entries = await svc.listLocal({ root, path: root })
    expect(entries.map(e => e.name)).toEqual(['Adir', 'zdir', 'a.md', 'b.txt'])
    expect(entries.map(e => e.kind)).toEqual(['dir', 'dir', 'file', 'file'])
    expect(entries[3]?.size).toBe(11)
    expect(entries[3]?.mtimeMs).toBeTypeOf('number')
  })
  it('子目录', async () => {
    const entries = await svc.listLocal({ root, path: join(root, 'zdir') })
    expect(entries.map(e => e.name)).toEqual(['inner.py'])
  })
  it('根外 → PATH_OUTSIDE_ROOT；不存在 → NOT_FOUND', async () => {
    expect(await codeOf(svc.listLocal({ root, path: outside }))).toBe('PATH_OUTSIDE_ROOT')
    expect(await codeOf(svc.listLocal({ root, path: join(root, 'nope') }))).toBe('NOT_FOUND')
  })

  // U-FS-LL-01：listLocal readdir 失败 → mapFsError 映射
  // 场景：传入一个存在但非目录的路径（文件），resolveInsideRoot 成功（文件存在），
  // 但 readdir(文件) 抛 ENOTDIR → 走 file-service.ts 91 行 mapFsError → NOT_FOUND。
  // 验证映射逻辑本身：ENOTDIR 映射为 NOT_FOUND，message 含"目录不存在"。
  it('传文件路径给 listLocal → readdir ENOTDIR → FileServiceError(NOT_FOUND, "目录不存在")', async () => {
    let caught: unknown
    try {
      await svc.listLocal({ root, path: join(root, 'b.txt') })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileServiceError)
    expect((caught as FileServiceError).code).toBe('NOT_FOUND')
    expect((caught as FileServiceError).message).toBe('目录不存在')
  })
})

describe('readLocal', () => {
  it('读全文', async () => {
    const r = await svc.readLocal({ root, path: join(root, 'b.txt') })
    expect(r).toEqual({ content: 'hello world', size: 11, truncated: false })
  })
  it('超过 maxBytes 只读前段并标 truncated', async () => {
    const r = await svc.readLocal({ root, path: join(root, 'b.txt') }, { maxBytes: 5 })
    expect(r).toEqual({ content: 'hello', size: 11, truncated: true })
  })
  it('目录 → VALIDATION；根外 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(svc.readLocal({ root, path: join(root, 'zdir') }))).toBe('VALIDATION')
    expect(await codeOf(svc.readLocal({ root, path: join(outside, 'x') }))).toBe('PATH_OUTSIDE_ROOT')
  })

  // U-FS-RL-01：readLocal 读取失败 → 抛 FileServiceError
  // 场景：传入一个不存在的文件路径，resolveInsideRoot 解析到 ENOENT 后抛 NOT_FOUND。
  // 验证 readLocal 对不存在路径的错误映射：抛 FileServiceError，code=NOT_FOUND，message 含"不存在"。
  it('不存在路径给 readLocal → FileServiceError(NOT_FOUND, 含"不存在")', async () => {
    let caught: unknown
    try {
      await svc.readLocal({ root, path: join(root, 'absent-file.txt') })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileServiceError)
    const err = caught as FileServiceError
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toContain('不存在')
  })

  // U-FS-RL-02：readLocal stat 成功后 readFile 失败 → 121 行 mapFsError 映射
  // 场景：文件存在（stat 成功，size <= maxBytes 走 readFile 路径），但 readFile 抛 ENOENT
  // （模拟 stat 后文件被删除的竞态）→ 走 file-service.ts 121 行 mapFsError(error, '文件')。
  // 验证映射逻辑本身：ENOENT → NOT_FOUND, message="文件不存在"。
  it('stat 成功后 readFile 抛 ENOENT → FileServiceError(NOT_FOUND, "文件不存在")', async () => {
    const readMock = vi.mocked(fsp.readFile).mockRejectedValueOnce(
      Object.assign(new Error('文件已消失'), { code: 'ENOENT' }),
    )
    try {
      let caught: unknown
      try {
        // b.txt 存在且 size=11 <= maxBytes，走 readFile 路径（109 行）
        await svc.readLocal({ root, path: join(root, 'b.txt') })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(FileServiceError)
      const err = caught as FileServiceError
      expect(err.code).toBe('NOT_FOUND')
      expect(err.message).toBe('文件不存在')
    } finally {
      readMock.mockRestore()
    }
  })
})

describe('writeLocal', () => {
  it('新建文件 → 内容正确、返回字节数、不留临时文件', async () => {
    const r = await svc.writeLocal({ root, path: join(root, 'new.txt') }, '你好')
    expect(r.bytes).toBe(6)
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('你好')
    expect((await readdir(root)).filter(n => n.includes('.tm-tmp-'))).toEqual([])
  })
  it('覆盖已有文件', async () => {
    await svc.writeLocal({ root, path: join(root, 'new.txt') }, 'v2')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('v2')
  })
  it('父目录不存在 → NOT_FOUND（不自动建目录）', async () => {
    expect(await codeOf(svc.writeLocal({ root, path: join(root, 'no', 'x.txt') }, 'x'))).toBe('NOT_FOUND')
  })
  it('目标是目录 → VALIDATION；根外 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(svc.writeLocal({ root, path: join(root, 'zdir') }, 'x'))).toBe('VALIDATION')
    expect(await codeOf(svc.writeLocal({ root, path: join(outside, 'x.txt') }, 'x'))).toBe('PATH_OUTSIDE_ROOT')
  })

  // U-FS-WL-01：writeLocal 写入失败 → 清理 tmp + mapFsError
  // 场景：writeFile(tmp) 成功创建临时文件后，renameAtomic(tmp→path) 抛 EACCES
  // （跨平台稳定：用 vi.spyOn 模拟 rename 拒绝，带 errno code='EACCES'）。
  // 走 file-service.ts 140-141 行：unlink(tmp).catch + mapFsError(EACCES) → VALIDATION。
  // 验证映射逻辑本身（EACCES → VALIDATION, message 含"没有访问权限"）+ 临时文件被 unlink 清理。
  it('rename 失败(EACCES) → 清理 tmp + FileServiceError(VALIDATION, "没有访问权限")', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'tm-fs-wl-'))
    try {
      // rename 被 vi.mock 包装为 vi.fn（默认透传真实实现），此处改为始终抛 EACCES
      // （renameAtomic 会重试 6 次 EACCES 后透传错误 → writeLocal catch → unlink(tmp) + mapFsError）
      const accErr = Object.assign(new Error('权限拒绝'), { code: 'EACCES' })
      const renameMock = vi.mocked(fsp.rename).mockRejectedValue(accErr)
      // unlink 同样被 vi.mock 包装；spy 其调用以验证临时文件清理
      const unlinkMock = vi.mocked(fsp.unlink)

      let caught: unknown
      try {
        await svc.writeLocal({ root: wsDir, path: join(wsDir, 'x.txt') }, 'data')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(FileServiceError)
      const err = caught as FileServiceError
      expect(err.code).toBe('VALIDATION')
      expect(err.message).toContain('没有访问权限')
      // 临时文件清理：unlink 被调用，且参数为 .tm-tmp 临时文件路径
      expect(unlinkMock).toHaveBeenCalled()
      const unlinkedPaths = unlinkMock.mock.calls.map(c => String(c[0]))
      expect(unlinkedPaths.some(p => p.includes('.tm-tmp-'))).toBe(true)
      // 工作目录下无 .tm-tmp 残留（writeFile 真实创建了 tmp，unlink 清理了它）
      const leftovers = (await readdir(wsDir)).filter(n => n.includes('.tm-tmp-'))
      expect(leftovers).toEqual([])
      renameMock.mockRestore()
      unlinkMock.mockClear()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })
})

describe('listDirectories（换目录选择器）', () => {
  it('只返回子目录，不受树根限制', async () => {
    const entries = await svc.listDirectories(root)
    expect(entries.map(e => e.name)).toEqual(['Adir', 'zdir'])
    expect(entries.every(e => e.kind === 'dir')).toBe(true)
    expect((await svc.listDirectories(outside))).toEqual([])
  })
  it('相对路径 → VALIDATION；不存在 → NOT_FOUND', async () => {
    expect(await codeOf(svc.listDirectories('rel'))).toBe('VALIDATION')
    expect(await codeOf(svc.listDirectories(join(root, 'nope')))).toBe('NOT_FOUND')
  })
})

describe('远端（未接入会话池的本地服务）', () => {
  it('四个方法都抛 UNSUPPORTED', async () => {
    expect(await codeOf(svc.listRemote({ sessionId: 's', path: '/' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.download({ sessionId: 's', remotePath: '/x' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.downloadToLocal({ sessionId: 's', remotePath: '/x', target: { root, path: root } }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.upload({ sessionId: 's', remotePath: '/x', source: { kind: 'local', ref: { root, path: root } } }))).toBe('UNSUPPORTED')
  })
})

describe('远端分派骨架（S5 步骤3）', () => {
  const sshSnap = (status: 'open' | 'closed' = 'open'): SessionSnapshot =>
    ({ sessionId: 's-1', label: 'dev', target: '1.2.3.4:22', protocol: 'ssh', status })
  const telnetSnap: SessionSnapshot =
    { sessionId: 's-2', label: 'dev', target: '1.2.3.4:23', protocol: 'telnet', status: 'open' }

  it('会话不存在 → SESSION_NOT_FOUND', async () => {
    const svc = new LocalFileService({ get: () => undefined, getSftp: async () => fakeSftpLike() })
    expect(await codeOf(svc.listRemote({ sessionId: 'gone', path: '/' }))).toBe('SESSION_NOT_FOUND')
  })

  it('closed 会话 → DISCONNECTED', async () => {
    const svc = new LocalFileService({ get: () => sshSnap('closed'), getSftp: async () => fakeSftpLike() })
    expect(await codeOf(svc.listRemote({ sessionId: 's-1', path: '/' }))).toBe('DISCONNECTED')
  })

  it('telnet 会话 → UNSUPPORTED（四个方法一致，且不取门面）', async () => {
    let tookSftp = false
    const svc = new LocalFileService({ get: () => telnetSnap, getSftp: async () => { tookSftp = true; return fakeSftpLike() } })
    expect(await codeOf(svc.listRemote({ sessionId: 's-2', path: '/' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.upload({ sessionId: 's-2', remotePath: '/a', source: { kind: 'stream', stream: Readable.from(['x']) } }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.download({ sessionId: 's-2', remotePath: '/a' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.downloadToLocal({ sessionId: 's-2', remotePath: '/a', target: { root, path: root } }))).toBe('UNSUPPORTED')
    expect(tookSftp).toBe(false)
  })

  it('ssh 会话：走通分派链（门面调用直达，步骤 4 起四件套实装）', async () => {
    const sftp = fakeSftpLike()
    let tookSftp = false
    const svc = new LocalFileService({ get: () => sshSnap(), getSftp: async () => { tookSftp = true; return sftp } })
    expect(await svc.listRemote({ sessionId: 's-1', path: '/' })).toEqual([])
    expect(tookSftp).toBe(true)
    expect(sftp.calls).toEqual(['list /'])
  })

  it('传输层错误映射：DISCONNECTED 保留，其余归 REMOTE_IO', async () => {
    const broken = (err: unknown): FileSessionGateway => ({ get: () => sshSnap(), getSftp: async () => { throw err } })
    const disconnected = new LocalFileService(broken(new TransportError('DISCONNECTED', 'SSH 连接已断开')))
    expect(await codeOf(disconnected.listRemote({ sessionId: 's-1', path: '/' }))).toBe('DISCONNECTED')
    const proto = new LocalFileService(broken(new TransportError('PROTO_ERROR', '打开 SFTP 子通道失败')))
    expect(await codeOf(proto.listRemote({ sessionId: 's-1', path: '/' }))).toBe('REMOTE_IO')
  })
})

describe('FileService 远端四件套（S5 步骤4，SSH 路径挂 mock SFTP 设备）', () => {
  const lab = createDeviceLab()
  const SESSION = 'sess-remote'
  const snapOf = (): SessionSnapshot => ({ sessionId: SESSION, label: 'dev', target: '127.0.0.1', protocol: 'ssh', status: 'open' })
  let devRoot = '' // 设备侧根目录（SFTP 的 '/'）
  let wsRoot = '' // 本地工作区树根
  let transport: Transport | undefined
  let svc: LocalFileService
  let fileEvents: Extract<TmEvent, { type: 'file' }>[]

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    await lab.cleanup()
    if (devRoot) await rm(devRoot, { recursive: true, force: true })
    if (wsRoot) await rm(wsRoot, { recursive: true, force: true })
    devRoot = ''
    wsRoot = ''
  })

  /** 每个测试独立起设备 + 会话快照 + 事件总线；getSftp 返回真实 SftpFacade（对 mock 设备） */
  const start = async (): Promise<void> => {
    devRoot = await mkdtemp(join(tmpdir(), 'tm-fs-dev-'))
    wsRoot = await mkdtemp(join(tmpdir(), 'tm-fs-ws-'))
    const { port } = await lab.startSftpDevice(devRoot)
    transport = await connectSsh({ host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } }, { onData: () => {}, onClose: () => {} })
    const sftp = await transport.getSftp!()
    const bus = createEventBus()
    fileEvents = []
    bus.on((e) => { if (e.type === 'file') fileEvents.push(e) })
    svc = new LocalFileService({ get: () => snapOf(), getSftp: async () => sftp }, bus)
  }

  const partialLeftovers = async (dir: string): Promise<string[]> =>
    (await readdir(dir)).filter((n) => n.includes('.tm-partial'))

  it('upload（本地树根内来源）：内容落位、返回字节、file 事件 ok', async () => {
    await start()
    await writeFile(join(wsRoot, 'up.txt'), 'hello remote')
    const res = await svc.upload({ sessionId: SESSION, remotePath: '/up.txt', source: { kind: 'local', ref: { root: wsRoot, path: join(wsRoot, 'up.txt') } } })
    expect(res.ok).toBe(true)
    expect(res.bytes).toBe(12)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    expect(await readFile(join(devRoot, 'up.txt'), 'utf8')).toBe('hello remote')
    expect(await partialLeftovers(devRoot)).toEqual([])
    expect(fileEvents).toHaveLength(1)
    expect(fileEvents[0]).toMatchObject({ type: 'file', sessionId: SESSION, op: 'upload', path: '/up.txt', ok: true, bytes: 12 })
  })

  it('upload（流来源）：进度回调出 total/percent 终值 100', async () => {
    await start()
    const data = Buffer.alloc(64 * 1024, 0x63)
    const seen: TransferProgress[] = []
    const res = await svc.upload({
      sessionId: SESSION,
      remotePath: '/big.bin',
      source: { kind: 'stream', stream: Readable.from([data]), size: data.length },
      onProgress: (p) => seen.push(p),
    })
    expect(res.bytes).toBe(data.length)
    expect(await readFile(join(devRoot, 'big.bin'))).toEqual(data)
    expect(seen[seen.length - 1]).toMatchObject({ op: 'upload', sessionId: SESSION, remotePath: '/big.bin', transferred: data.length, total: data.length, percent: 100 })
  })

  it('upload 来源在树根外 → PATH_OUTSIDE_ROOT；file 事件 ok:false', async () => {
    await start()
    const outside = await mkdtemp(join(tmpdir(), 'tm-fs-out-'))
    try {
      await expect(svc.upload({ sessionId: SESSION, remotePath: '/x', source: { kind: 'local', ref: { root: wsRoot, path: join(outside, 'secret.txt') } } }))
        .rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' })
      expect(fileEvents[0]).toMatchObject({ op: 'upload', ok: false })
      expect(fileEvents[0]?.error).toBeTruthy()
      expect(await readdir(devRoot)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('listRemote：目录在前、名字不分大小写、带 kind/size', async () => {
    await start()
    await writeFile(join(devRoot, 'b.txt'), '0123456789')
    await writeFile(join(devRoot, 'A.txt'), 'xyz')
    await mkdir(join(devRoot, 'zdir'))
    const entries = await svc.listRemote({ sessionId: SESSION, path: '/' })
    expect(entries.map((e) => e.name)).toEqual(['zdir', 'A.txt', 'b.txt'])
    expect(entries.map((e) => e.kind)).toEqual(['dir', 'file', 'file'])
    expect(entries[2]?.size).toBe(10)
  })

  it('download：流内容一致、进度终值 100、结束 file 事件 ok（bytes=总大小）', async () => {
    await start()
    const data = Buffer.alloc(48 * 1024 + 3, 0x64)
    await writeFile(join(devRoot, 'ds.bin'), data)
    const seen: TransferProgress[] = []
    const { stream, size } = await svc.download({ sessionId: SESSION, remotePath: '/ds.bin', onProgress: (p) => seen.push(p) })
    expect(size).toBe(data.length)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks)).toEqual(data)
    expect(seen[seen.length - 1]).toMatchObject({ op: 'download', transferred: data.length, total: data.length, percent: 100 })
    expect(fileEvents).toHaveLength(1)
    expect(fileEvents[0]).toMatchObject({ op: 'download', path: '/ds.bin', ok: true, bytes: data.length })
  })

  it('downloadToLocal：落位到树根、覆盖旧内容、无半成品残留、file 事件 ok', async () => {
    await start()
    await writeFile(join(devRoot, 'd.txt'), 'device-content')
    await writeFile(join(wsRoot, 'd.txt'), 'old-content')
    const res = await svc.downloadToLocal({ sessionId: SESSION, remotePath: '/d.txt', target: { root: wsRoot, path: join(wsRoot, 'd.txt') } })
    expect(res).toMatchObject({ ok: true, bytes: 14 })
    expect(await readFile(join(wsRoot, 'd.txt'), 'utf8')).toBe('device-content')
    expect(await partialLeftovers(wsRoot)).toEqual([])
    expect(fileEvents[0]).toMatchObject({ op: 'download', path: '/d.txt', ok: true, bytes: 14 })
  })

  it('downloadToLocal 中途失败：本地无半成品、旧文件保留、file 事件 ok:false', async () => {
    await start()
    await writeFile(join(wsRoot, 'keep.txt'), 'original')
    const sftp = fakeSftpLike()
    sftp.get = async (_remotePath, localPath) => {
      await writeFile(localPath, 'half-written')
      throw new FileServiceError('REMOTE_IO', '传输中断')
    }
    const events: Extract<TmEvent, { type: 'file' }>[] = []
    const bus = createEventBus()
    bus.on((e) => { if (e.type === 'file') events.push(e) })
    const broken = new LocalFileService({ get: () => snapOf(), getSftp: async () => sftp }, bus)
    await expect(broken.downloadToLocal({ sessionId: SESSION, remotePath: '/keep.txt', target: { root: wsRoot, path: join(wsRoot, 'keep.txt') } }))
      .rejects.toMatchObject({ code: 'REMOTE_IO' })
    expect(await readFile(join(wsRoot, 'keep.txt'), 'utf8')).toBe('original')
    expect(await partialLeftovers(wsRoot)).toEqual([])
    expect(events[0]).toMatchObject({ op: 'download', ok: false, error: '传输中断' })
  })

  it('downloadToLocal 目标在树根外 → PATH_OUTSIDE_ROOT；file 事件 ok:false', async () => {
    await start()
    const outside = await mkdtemp(join(tmpdir(), 'tm-fs-out2-'))
    try {
      await expect(svc.downloadToLocal({ sessionId: SESSION, remotePath: '/d.txt', target: { root: wsRoot, path: join(outside, 'd.txt') } }))
        .rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' })
      expect(fileEvents[0]).toMatchObject({ op: 'download', ok: false })
      expect(await readdir(devRoot)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('download 流中途报错 → file 事件 ok:false（error 带原因）', async () => {
    await start()
    const sftp = fakeSftpLike()
    sftp.downloadStream = async () => ({
      stream: new Readable({ read() { this.destroy(new FileServiceError('REMOTE_IO', '设备读失败')) } }),
    })
    const events: Extract<TmEvent, { type: 'file' }>[] = []
    const bus = createEventBus()
    bus.on((e) => { if (e.type === 'file') events.push(e) })
    const broken = new LocalFileService({ get: () => snapOf(), getSftp: async () => sftp }, bus)
    const { stream } = await broken.download({ sessionId: SESSION, remotePath: '/x' })
    const consume = async (): Promise<void> => { for await (const _c of stream) { /* 消费直到出错 */ } }
    await expect(consume()).rejects.toMatchObject({ code: 'REMOTE_IO' })
    expect(events[0]).toMatchObject({ op: 'download', ok: false, error: '设备读失败' })
  })

  it('download 被取消（close 而未 end）→ file 事件 ok:false「传输被取消」', async () => {
    await start()
    const sftp = fakeSftpLike()
    sftp.downloadStream = async () => ({ stream: new Readable({ read() { this.push('part'); this.destroy() } }) })
    const events: Extract<TmEvent, { type: 'file' }>[] = []
    const bus = createEventBus()
    bus.on((e) => { if (e.type === 'file') events.push(e) })
    const broken = new LocalFileService({ get: () => snapOf(), getSftp: async () => sftp }, bus)
    const { stream } = await broken.download({ sessionId: SESSION, remotePath: '/x' })
    stream.resume()
    await once(stream, 'close')
    expect(events[0]).toMatchObject({ op: 'download', ok: false, error: '传输被取消' })
  })
})

describe('边界：中文文件名 / 并发写 / symlink 不跟随', () => {
  it('中文文件名读写往返', async () => {
    const p = join(root, '测试文件.txt')
    const r = await svc.writeLocal({ root, path: p }, '中文内容你好')
    expect(r.bytes).toBe(Buffer.byteLength('中文内容你好', 'utf8'))
    const read = await svc.readLocal({ root, path: p })
    expect(read.content).toBe('中文内容你好')
    expect(read.truncated).toBe(false)
    // listLocal 也能列出中文文件名
    const entries = await svc.listLocal({ root, path: root })
    expect(entries.some(e => e.name === '测试文件.txt')).toBe(true)
  })

  it('并发写同一文件：最终内容是其中一次，无临时文件残留', async () => {
    const p = join(root, 'concurrent.txt')
    await Promise.all([
      svc.writeLocal({ root, path: p }, 'version-a'),
      svc.writeLocal({ root, path: p }, 'version-b'),
    ])
    const final = await readFile(p, 'utf8')
    expect(['version-a', 'version-b']).toContain(final)
    // 不留临时文件
    const files = await readdir(root)
    expect(files.filter(n => n.includes('.tm-tmp-'))).toEqual([])
  })

  it('listLocal：symlink 标 symlink 不跟随（指向目录也不递归）', async ({ skip }) => {
    const linkPath = join(root, 'a-link')
    try {
      await symlink(join(root, 'zdir'), linkPath, 'junction')
    } catch {
      skip() // Windows 无权限建 junction 时跳过
    }
    const entries = await svc.listLocal({ root, path: root })
    const link = entries.find(e => e.name === 'a-link')
    expect(link).toBeDefined()
    expect(link?.kind).toBe('symlink')
    // 不带 size / mtimeMs（没 stat 跟随）
    expect(link?.size).toBeUndefined()
  })
})

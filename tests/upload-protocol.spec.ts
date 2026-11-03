/**
 * UploadSessionManager：create / writeChunk / complete / status / cancel、
 * 乱序与重发、空洞校验、TooMany、TTL、uploads.json 持久化恢复、路径校验。
 * 全部用内存假 SFTP，不碰真实设备。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileServiceError } from '../src/file-errors.ts'
import type { FileEntry } from '../src/types/file-service.ts'
import type { SftpLike, SftpWriteHandle } from '../src/transport/types.ts'
import {
  DEFAULT_CHUNK_SIZE,
  UploadSessionManager,
  chunkSpan,
  type UploadSessionManagerOptions,
  type UploadWriter,
} from '../src/upload-protocol.ts'

/** 内存远端文件系统（只实现分片上传用到的面）。 */
class FakeSftp implements SftpLike {
  readonly files = new Map<string, Buffer>()
  readonly openModes: Array<{ path: string; mode: 'w' | 'r+' }> = []
  readonly unlinked: string[] = []
  closedHandles = 0
  /** 让下一次 stat 抛这个错（模拟非 NOT_FOUND 的远端故障） */
  statError: unknown

  async list(): Promise<FileEntry[]> { return [] }
  async realpath(p: string): Promise<string> { return p }
  async stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; isSymlink: boolean; size?: number }> {
    if (this.statError !== undefined) {
      const error = this.statError
      this.statError = undefined
      throw error
    }
    const data = this.files.get(path)
    if (data === undefined) throw new FileServiceError('NOT_FOUND', `${path}不存在`)
    return { isDirectory: false, isFile: true, isSymlink: false, size: data.length }
  }
  async mkdirs(): Promise<void> {}
  async put(): Promise<{ bytes: number }> { return { bytes: 0 } }
  async get(): Promise<{ bytes: number }> { return { bytes: 0 } }
  async downloadStream(): Promise<{ stream: import('node:stream').Readable }> { throw new Error('not used') }

  async openWrite(path: string, mode: 'w' | 'r+' = 'w'): Promise<SftpWriteHandle> {
    this.openModes.push({ path, mode })
    if (mode === 'w') {
      this.files.set(path, Buffer.alloc(0))
    } else if (!this.files.has(path)) {
      throw new FileServiceError('NOT_FOUND', `${path}不存在`)
    }
    return {
      write: async (buffer: Buffer, position: number) => {
        const current = this.files.get(path) ?? Buffer.alloc(0)
        const end = position + buffer.length
        const next = end > current.length ? Buffer.alloc(end) : current
        current.copy(next, 0, 0, Math.min(current.length, next.length))
        buffer.copy(next, position)
        this.files.set(path, next)
      },
      close: async () => { this.closedHandles += 1 },
    }
  }

  async replace(from: string, to: string): Promise<void> {
    const data = this.files.get(from)
    if (data === undefined) throw new FileServiceError('NOT_FOUND', `${from}不存在`)
    this.files.delete(from)
    this.files.set(to, data)
  }

  async unlink(path: string): Promise<void> {
    this.unlinked.push(path)
    this.files.delete(path)
  }
}

interface RigOptions extends Partial<Omit<UploadSessionManagerOptions, 'getSftp' | 'dataDir'>> {
  sessionId?: string
}

const rigs: Array<{ manager: UploadSessionManager; dir: string }> = []

async function makeRig(options: RigOptions = {}): Promise<{ manager: UploadSessionManager; sftp: FakeSftp; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-upload-'))
  const sftp = new FakeSftp()
  const sessions = new Map<string, FakeSftp>([[options.sessionId ?? 's1', sftp]])
  const { sessionId: _ignored, ...managerOptions } = options
  const manager = new UploadSessionManager({
    getSftp: async (id) => {
      const found = sessions.get(id)
      if (found === undefined) throw new FileServiceError('SESSION_NOT_FOUND', `会话不存在: ${id}`)
      return found
    },
    dataDir: dir,
    cleanupIntervalMs: 0,
    ...managerOptions,
  })
  rigs.push({ manager, dir })
  return { manager, sftp, dir }
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()!
    await rig.manager.closeAll()
    await rm(rig.dir, { recursive: true, force: true })
  }
})

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'OK'
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

describe('UploadSessionManager.create', () => {
  it('建远端临时文件（同目录、名字带 uploadId）并返回分片计划', async () => {
    const { manager, sftp } = await makeRig({ defaultChunkSize: 4 })
    const result = await manager.create({ sessionId: 's1', remotePath: '/dir/a.bin', totalBytes: 10 })
    expect(result.chunkSize).toBe(4)
    expect(result.totalChunks).toBe(3)
    expect(result.tempPath).toBe(`/dir/.dsh-tmp-${result.uploadId}-a.bin`)
    expect(sftp.openModes).toEqual([{ path: result.tempPath, mode: 'w' }])
    expect(sftp.files.has(result.tempPath)).toBe(true)
    const status = await manager.status(result.uploadId)
    expect(status).toMatchObject({
      uploadId: result.uploadId,
      remotePath: '/dir/a.bin',
      totalBytes: 10,
      chunkSize: 4,
      totalChunks: 3,
      receivedOffsets: [],
    })
    expect(status.expiresAtMs).toBeGreaterThan(status.createdAtMs)
  })

  it('根目录文件临时名以 / 开头；默认分片 4 MiB', async () => {
    const { manager } = await makeRig()
    const result = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10 })
    expect(result.tempPath.startsWith('/.dsh-tmp-')).toBe(true)
    expect(result.chunkSize).toBe(DEFAULT_CHUNK_SIZE)
    expect(result.totalChunks).toBe(1)
  })

  it('参数校验：相对路径、目录路径、非法 totalBytes/chunkSize', async () => {
    const { manager } = await makeRig()
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: 'rel/a.bin', totalBytes: 1 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/dir/', totalBytes: 1 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/a\0b', totalBytes: 1 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 0 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 1.5 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10, chunkSize: 0 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10, chunkSize: 65 * 1024 * 1024 }))).toBe('VALIDATION')
    expect(await codeOf(manager.create({ sessionId: '', remotePath: '/a.bin', totalBytes: 10 }))).toBe('VALIDATION')
  })

  it('会话不存在 → SESSION_NOT_FOUND；错误消息不含凭据', async () => {
    const { manager } = await makeRig()
    let message = ''
    try {
      await manager.create({ sessionId: 's-nope', remotePath: '/a.bin', totalBytes: 10 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      expect((error as { code?: string }).code).toBe('SESSION_NOT_FOUND')
    }
    expect(message).not.toMatch(/password|passphrase|test-pass|secret/i)
  })

  it('全局活动上传超过上限 → TOO_MANY_UPLOADS（内部扩展码）', async () => {
    const { manager } = await makeRig({ maxActiveUploads: 2 })
    await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    await manager.create({ sessionId: 's1', remotePath: '/b.bin', totalBytes: 4 })
    let caught: { code?: unknown; message?: string } | undefined
    try {
      await manager.create({ sessionId: 's1', remotePath: '/c.bin', totalBytes: 4 })
    } catch (error) {
      caught = error as { code?: unknown; message?: string }
    }
    expect(String(caught?.code)).toBe('TOO_MANY_UPLOADS')
    expect(caught?.message).toContain('上限')
    expect(manager.activeCount).toBe(2)
  })
})

describe('UploadSessionManager.writeChunk / complete', () => {
  it('乱序 + 重发：receivedOffsets 去重升序；缺片 complete 报 VALIDATION', async () => {
    const { manager, sftp } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId, tempPath } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10 })

    await manager.writeChunk(uploadId, 2, bytes('ij'))
    await manager.writeChunk(uploadId, 0, bytes('abcd'))
    await manager.writeChunk(uploadId, 0, bytes('abcd')) // 重发
    expect((await manager.status(uploadId)).receivedOffsets).toEqual([0, 2])
    expect(sftp.files.get(tempPath)?.subarray(0, 4).toString()).toBe('abcd')

    await expect(manager.complete(uploadId)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(manager.complete(uploadId)).rejects.toThrow(/缺少 1 片/)

    await manager.writeChunk(uploadId, 1, bytes('efgh'))
    const done = await manager.complete(uploadId)
    expect(done).toEqual({ ok: true, bytes: 10, remotePath: '/a.bin' })
    expect(sftp.files.get('/a.bin')?.toString()).toBe('abcdefghij')
    expect(sftp.files.has(tempPath)).toBe(false)
    expect(await codeOf(manager.status(uploadId))).toBe('NOT_FOUND')
    // status 失败后 complete 幂等地报不存在
    expect(await codeOf(manager.complete(uploadId))).toBe('NOT_FOUND')
  })

  it('支持显式 offset（必须与 chunkIndex 匹配）', async () => {
    const { manager } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 8 })
    await manager.writeChunk(uploadId, 1, bytes('efgh'), 4)
    expect((await manager.status(uploadId)).receivedOffsets).toEqual([1])
    await expect(manager.writeChunk(uploadId, 1, bytes('efgh'), 0)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('分片越界 / 长度不符 / 非二进制 / 未知上传 → VALIDATION / NOT_FOUND', async () => {
    const { manager } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10 })
    expect(await codeOf(manager.writeChunk(uploadId, 3, bytes('abcd')))).toBe('VALIDATION')
    expect(await codeOf(manager.writeChunk(uploadId, -1, bytes('abcd')))).toBe('VALIDATION')
    expect(await codeOf(manager.writeChunk(uploadId, 0, bytes('ab')))).toBe('VALIDATION')
    expect(await codeOf(manager.writeChunk(uploadId, 0, 'abcd' as never))).toBe('VALIDATION')
    expect(await codeOf(manager.writeChunk('nope', 0, bytes('abcd')))).toBe('NOT_FOUND')
  })

  it('最后一片必须是剩余长度（不能整片）', async () => {
    const { manager } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10 })
    expect(chunkSpan(2, 4, 10)).toEqual({ offset: 8, length: 2 })
    expect(await codeOf(manager.writeChunk(uploadId, 2, bytes('ijkl')))).toBe('VALIDATION')
  })

  it('并发写不同分片都记账成功', async () => {
    const { manager } = await makeRig({ defaultChunkSize: 2 })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 6 })
    await Promise.all([
      manager.writeChunk(uploadId, 0, bytes('ab')),
      manager.writeChunk(uploadId, 1, bytes('cd')),
      manager.writeChunk(uploadId, 2, bytes('ef')),
    ])
    expect((await manager.status(uploadId)).receivedOffsets).toEqual([0, 1, 2])
    await expect(manager.complete(uploadId)).resolves.toMatchObject({ ok: true, bytes: 6 })
  })

  it('换章节：writer 被 poison 后自动关闭并重开新句柄', async () => {
    let first = true
    let closedStale = 0
    const factory = async (sftp: FakeSftp, path: string, mode: 'w' | 'r+', _options: unknown): Promise<UploadWriter> => {
      if (first) {
        first = false
        return {
          props: { poisoned: true },
          write: async () => { throw new Error('poisoned') },
          close: async () => { closedStale += 1 },
        }
      }
      return (await sftp.openWrite(path, mode)) as unknown as UploadWriter
    }
    const { manager } = await makeRig({ defaultChunkSize: 4, writerFactory: factory as never })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    await manager.writeChunk(uploadId, 0, bytes('abcd'))
    expect(closedStale).toBe(1)
    await expect(manager.complete(uploadId)).resolves.toMatchObject({ ok: true })
  })
})

describe('UploadSessionManager.cancel / TTL', () => {
  it('cancel 删临时文件、幂等；再 status → NOT_FOUND', async () => {
    const { manager, sftp } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId, tempPath } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    await expect(manager.cancel(uploadId)).resolves.toEqual({ ok: true })
    expect(sftp.files.has(tempPath)).toBe(false)
    expect(sftp.unlinked).toContain(tempPath)
    expect(await codeOf(manager.status(uploadId))).toBe('NOT_FOUND')
    await expect(manager.cancel(uploadId)).resolves.toEqual({ ok: true })
  })

  it('TTL 过期：status 报 NOT_FOUND、临时文件被清理、activeCount 归零', async () => {
    let clock = 1_000_000
    const { manager, sftp, dir } = await makeRig({ ttlMs: 100, now: () => clock })
    const { uploadId, tempPath } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    expect(await manager.purgeExpired()).toBe(0)
    clock += 101
    expect(await codeOf(manager.status(uploadId))).toBe('NOT_FOUND')
    expect(sftp.files.has(tempPath)).toBe(false)
    expect(manager.activeCount).toBe(0)
    const persisted = JSON.parse(await readFile(join(dir, 'uploads.json'), 'utf8')) as { version: number; uploads: unknown[] }
    expect(persisted.version).toBe(1)
    expect(persisted.uploads).toHaveLength(0)
  })

  it('定时器自动清理过期上传（cleanupIntervalMs）', async () => {
    const { manager, sftp } = await makeRig({ ttlMs: 10, cleanupIntervalMs: 10 })
    const { tempPath } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(manager.activeCount).toBe(0)
    expect(sftp.files.has(tempPath)).toBe(false)
  })
})

describe('UploadSessionManager 持久化 / 断点续传', () => {
  it('uploads.json 落盘 → 新实例恢复 receivedOffsets，懒用 r+ 重开句柄后续传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-upload-persist-'))
    const sftp = new FakeSftp()
    const make = (): UploadSessionManager => new UploadSessionManager({
      getSftp: async () => sftp,
      dataDir: dir,
      defaultChunkSize: 4,
      cleanupIntervalMs: 0,
    })
    const first = make()
    const { uploadId, tempPath } = await first.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10 })
    await first.writeChunk(uploadId, 0, bytes('abcd'))
    await first.closeAll()

    // 磁盘格式可读；closeAll 不删临时文件（仍可续传）
    const envelope = JSON.parse(await readFile(join(dir, 'uploads.json'), 'utf8')) as {
      version: number
      uploads: Array<{ uploadId: string; receivedOffsets: number[] }>
    }
    expect(envelope.version).toBe(1)
    expect(envelope.uploads).toHaveLength(1)
    expect(envelope.uploads[0]).toMatchObject({ uploadId, receivedOffsets: [0] })
    expect(sftp.files.has(tempPath)).toBe(true)

    const second = make()
    const status = await second.status(uploadId)
    expect(status.receivedOffsets).toEqual([0])
    await second.writeChunk(uploadId, 1, bytes('efgh'))
    // 断点续传必须用 r+（不能用 w 截断已写内容）
    expect(sftp.openModes.at(-1)).toEqual({ path: tempPath, mode: 'r+' })
    await second.writeChunk(uploadId, 2, bytes('ij'))
    await expect(second.complete(uploadId)).resolves.toMatchObject({ ok: true, bytes: 10 })
    expect(sftp.files.get('/a.bin')?.toString()).toBe('abcdefghij')
    await second.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it('恢复记录但临时文件已不在 → 从头写（offsets 重置、mode=w）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-upload-missing-'))
    const sftp = new FakeSftp()
    const make = (): UploadSessionManager => new UploadSessionManager({
      getSftp: async () => sftp,
      dataDir: dir,
      defaultChunkSize: 4,
      cleanupIntervalMs: 0,
    })
    const first = make()
    const { uploadId, tempPath } = await first.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    await first.writeChunk(uploadId, 0, bytes('abcd'))
    await first.closeAll()
    sftp.files.delete(tempPath)
    const second = make()
    await second.writeChunk(uploadId, 0, bytes('wxyz'))
    expect(sftp.openModes.at(-1)).toEqual({ path: tempPath, mode: 'w' })
    expect((await second.status(uploadId)).receivedOffsets).toEqual([0])
    await second.complete(uploadId)
    expect(sftp.files.get('/a.bin')?.toString()).toBe('wxyz')
    await second.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it('uploads.json 损坏 / 版本不符 → 安全重建（create 仍可用）', async () => {
    const { manager, dir } = await makeRig()
    await writeFile(join(dir, 'uploads.json'), '{oops not json', 'utf8')
    const created = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    expect(created.uploadId).toBeTypeOf('string')

    await manager.closeAll()
    await writeFile(join(dir, 'uploads.json'), JSON.stringify({ version: 99, uploads: [{ uploadId: 'x' }] }), 'utf8')
    const third = new UploadSessionManager({ getSftp: async () => new FakeSftp(), dataDir: dir, cleanupIntervalMs: 0 })
    await expect(third.status('x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await third.closeAll()
  })

  it('非法持久化条目被丢弃，合法条目保留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-upload-entries-'))
    await writeFile(join(dir, 'uploads.json'), JSON.stringify({
      version: 1,
      uploads: [
        { uploadId: 'bad' },
        {
          uploadId: 'good', sessionId: 's1', remotePath: '/a.bin', tempPath: '/.dsh-tmp-good-a.bin',
          totalBytes: 4, chunkSize: 4, totalChunks: 1, receivedOffsets: [0],
          createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        },
        {
          uploadId: 'bad-offset', sessionId: 's1', remotePath: '/b.bin', tempPath: '/.dsh-tmp-bad-b.bin',
          totalBytes: 4, chunkSize: 4, totalChunks: 1, receivedOffsets: [99],
          createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        },
      ],
    }), 'utf8')
    const sftp = new FakeSftp()
    sftp.files.set('/.dsh-tmp-good-a.bin', bytes('abcd'))
    const manager = new UploadSessionManager({ getSftp: async () => sftp, dataDir: dir, cleanupIntervalMs: 0 })
    await expect(manager.status('bad')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(manager.status('bad-offset')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const status = await manager.status('good')
    expect(status.receivedOffsets).toEqual([0])
    await manager.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it('stat 非 NOT_FOUND 故障 → 原样映射（REMOTE_IO），不静默吞掉', async () => {
    const { manager, sftp } = await makeRig({ defaultChunkSize: 4 })
    const { uploadId } = await manager.create({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 4 })
    const record = (manager as unknown as { uploads: Map<string, { writer?: UploadWriter }> }).uploads.get(uploadId)
    if (record !== undefined) {
      record.writer = { props: { poisoned: true }, write: async () => {}, close: async () => {} }
    }
    sftp.statError = new FileServiceError('REMOTE_IO', '读取信息失败: 设备异常')
    await expect(manager.writeChunk(uploadId, 0, bytes('abcd'))).rejects.toMatchObject({ code: 'REMOTE_IO' })
  })
})

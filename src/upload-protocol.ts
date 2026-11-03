/**
 * 大文件分片上传 —— host 半的会话状态机。
 *
 * 一次上传 = 一个 `UploadSessionManager` 里的记录：
 * 远端同目录临时文件 `.dsh-tmp-<uploadId>-<basename>` + 分片位图 + SFTP pwrite 句柄。
 * create 建临时文件与句柄；writeChunk 按分片序号（可乱序/重发）写入；complete 校验
 * 无空洞后 rename 原子落位；cancel / TTL 清理关句柄并尽力删临时文件。
 *
 * 断点续传：记录持久化到 `<dataDir>/uploads.json`（`{version:1, uploads:[...]}`），
 * host 重启后懒加载恢复；句柄不持久化，第一次写入时用 `r+` 重新打开（文件不在则从头来）。
 *
 * 错误统一用 FileServiceError（`TOO_MANY_UPLOADS` 是内部扩展码，未改 `src/types/` 契约），
 * message 只描述问题，不含凭据。
 * @module dsh-terminal-manager/upload-protocol
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join as joinLocal } from 'node:path'
import { basename as posixBasename, dirname as posixDirname } from 'node:path/posix'
import { FileServiceError } from './file-errors.ts'
import type { FileErrorCode } from './types/file-service.ts'
import { SftpConcurrentWriter, type SftpConcurrentWriterOptions } from './transport/sftp-concurrent-writer.ts'
import type { SftpLike } from './transport/types.ts'

/** 默认分片大小：4 MiB。 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
/** 单分片上限（防御性；客户端用 4 MiB）。 */
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024
/** 上传会话 TTL：1 小时。 */
export const DEFAULT_UPLOAD_TTL_MS = 60 * 60 * 1000
/** 全局同时进行的上传上限。 */
export const DEFAULT_MAX_ACTIVE_UPLOADS = 3
/** 分片数上限（1 字节分片也最多 100 万片，防异常请求撑爆内存）。 */
export const MAX_TOTAL_CHUNKS = 1_000_000
/** 持久化文件名（位于 dataDir 下）。 */
export const UPLOADS_FILE_NAME = 'uploads.json'

/** 内部扩展错误码：契约 FileErrorCode 尚未收录，但路由 / 前端按字符串识别。 */
export type UploadErrorCode = FileErrorCode | 'TOO_MANY_UPLOADS'

/**
 * 上传域错误。运行时 `code` 可能是 `TOO_MANY_UPLOADS`（契约文件不改，
 * 继承 FileServiceError 以复用它的错误映射与 404/400 判定）。
 */
export class UploadError extends FileServiceError {
  constructor(code: UploadErrorCode, message: string, options?: { cause?: unknown }) {
    super(code as FileErrorCode, message, options)
  }
}

/** 写入器最小面（SftpConcurrentWriter 或测试注入的假实现）。 */
export interface UploadWriter {
  readonly props: { poisoned: boolean }
  write(buffer: Buffer, position: number): Promise<void>
  close(): Promise<void>
}

/** create 入参。 */
export interface UploadCreateInput {
  sessionId: string
  remotePath: string
  totalBytes: number
  chunkSize?: number
}

/** create 返回值。 */
export interface UploadCreateResult {
  uploadId: string
  tempPath: string
  chunkSize: number
  totalChunks: number
}

/** writeChunk 返回值。 */
export interface UploadChunkResult {
  uploadId: string
  chunkIndex: number
  bytes: number
}

/** complete 返回值。 */
export interface UploadCompleteResult {
  ok: true
  bytes: number
  remotePath: string
}

/** status 返回值（receivedOffsets = 已收到的分片序号，升序、去重）。 */
export interface UploadStatus {
  uploadId: string
  remotePath: string
  totalBytes: number
  chunkSize: number
  totalChunks: number
  receivedOffsets: number[]
  createdAtMs: number
  expiresAtMs: number
}

/** 持久化记录（不含 writer 句柄）。 */
interface PersistedUpload {
  uploadId: string
  sessionId: string
  remotePath: string
  tempPath: string
  totalBytes: number
  chunkSize: number
  totalChunks: number
  receivedOffsets: number[]
  createdAtMs: number
  expiresAtMs: number
}

interface UploadRecord extends PersistedUpload {
  /** SFTP 写入句柄（懒打开；不持久化） */
  writer?: UploadWriter
}

/** 构造依赖（index.ts 注入；测试可全用假实现）。 */
export interface UploadSessionManagerOptions {
  /** 取会话的 SFTP 门面（LocalFileService.getSftp；内部做会话/协议校验） */
  getSftp: (sessionId: string) => Promise<SftpLike>
  /** 持久化目录（uploads.json 所在） */
  dataDir: string
  /** 默认分片大小（create 未指定时） */
  defaultChunkSize?: number
  /** TTL（毫秒） */
  ttlMs?: number
  /** 全局活动上传上限 */
  maxActiveUploads?: number
  /** 当前时间（测试注入） */
  now?: () => number
  /** 定时清理间隔（毫秒）；0 = 不启动定时器 */
  cleanupIntervalMs?: number
  /** 写入器工厂（测试注入；缺省 SftpConcurrentWriter.open） */
  writerFactory?: (sftp: SftpLike, path: string, mode: 'w' | 'r+', options: SftpConcurrentWriterOptions) => Promise<UploadWriter>
}

/** 校验远端绝对路径并返回目录 / 文件名。 */
function splitRemotePath(remotePath: unknown): { dir: string; name: string } {
  if (typeof remotePath !== 'string' || remotePath.length === 0) {
    throw new UploadError('VALIDATION', 'remotePath 不能为空')
  }
  if (remotePath.includes('\0')) throw new UploadError('VALIDATION', 'remotePath 含非法字符')
  if (!remotePath.startsWith('/')) throw new UploadError('VALIDATION', 'remotePath 必须是绝对路径')
  if (remotePath.endsWith('/')) throw new UploadError('VALIDATION', 'remotePath 必须指向文件，不能是目录')
  const name = posixBasename(remotePath)
  if (name.length === 0 || name === '.' || name === '..') {
    throw new UploadError('VALIDATION', 'remotePath 缺少合法文件名')
  }
  return { dir: posixDirname(remotePath), name }
}

/** 校验分片大小。 */
function requireChunkSize(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_CHUNK_SIZE) {
    throw new UploadError('VALIDATION', `chunkSize 必须是 1–${MAX_CHUNK_SIZE} 的整数`)
  }
  return value
}

/** 分片序号对应的字节区间。 */
export function chunkSpan(index: number, chunkSize: number, totalBytes: number): { offset: number; length: number } {
  const offset = index * chunkSize
  return { offset, length: Math.max(0, Math.min(chunkSize, totalBytes - offset)) }
}

/** 持久化记录校验（损坏的条目直接丢弃）。 */
function parsePersisted(raw: unknown): PersistedUpload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.uploadId !== 'string' || r.uploadId.length === 0) return undefined
  if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) return undefined
  if (typeof r.remotePath !== 'string' || !r.remotePath.startsWith('/')) return undefined
  if (typeof r.tempPath !== 'string' || !r.tempPath.startsWith('/')) return undefined
  if (typeof r.totalBytes !== 'number' || !Number.isSafeInteger(r.totalBytes) || r.totalBytes <= 0) return undefined
  if (typeof r.chunkSize !== 'number' || !Number.isSafeInteger(r.chunkSize) || r.chunkSize <= 0 || r.chunkSize > MAX_CHUNK_SIZE) return undefined
  if (typeof r.createdAtMs !== 'number' || !Number.isFinite(r.createdAtMs)) return undefined
  if (typeof r.expiresAtMs !== 'number' || !Number.isFinite(r.expiresAtMs)) return undefined
  const totalChunks = Math.ceil(r.totalBytes / r.chunkSize)
  if (totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) return undefined
  if (!Array.isArray(r.receivedOffsets)) return undefined
  const offsets = new Set<number>()
  for (const item of r.receivedOffsets) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item >= totalChunks) return undefined
    offsets.add(item)
  }
  return {
    uploadId: r.uploadId,
    sessionId: r.sessionId,
    remotePath: r.remotePath,
    tempPath: r.tempPath,
    totalBytes: r.totalBytes,
    chunkSize: r.chunkSize,
    totalChunks,
    receivedOffsets: [...offsets].sort((a, b) => a - b),
    createdAtMs: r.createdAtMs,
    expiresAtMs: r.expiresAtMs,
  }
}

/**
 * 分片上传会话管理器。
 * 所有公开方法先懒加载 uploads.json（host 重启后的断点续传），再清一次过期会话。
 */
export class UploadSessionManager {
  private readonly getSftp: UploadSessionManagerOptions['getSftp']
  private readonly dataDir: string
  private readonly defaultChunkSize: number
  private readonly ttlMs: number
  private readonly maxActiveUploads: number
  private readonly now: () => number
  private readonly writerFactory: NonNullable<UploadSessionManagerOptions['writerFactory']>
  private readonly uploads = new Map<string, UploadRecord>()
  private readonly cleanupTimer: ReturnType<typeof setInterval> | undefined
  private loaded = false
  private loading: Promise<void> | undefined
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: UploadSessionManagerOptions) {
    this.getSftp = options.getSftp
    this.dataDir = options.dataDir
    this.defaultChunkSize = options.defaultChunkSize ?? DEFAULT_CHUNK_SIZE
    this.ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS
    this.maxActiveUploads = options.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS
    this.now = options.now ?? Date.now
    this.writerFactory = options.writerFactory
      ?? ((sftp, path, mode) => SftpConcurrentWriter.open(sftp, path, { mode }))
    const intervalMs = options.cleanupIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.purgeExpired().catch(() => {})
      }, intervalMs)
      ;(this.cleanupTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /** 当前活动上传数（含尚未完成的恢复记录）。 */
  get activeCount(): number {
    return this.uploads.size
  }

  /** 创建上传：校验参数、打开远端临时文件写入句柄、返回分片计划。 */
  async create(input: UploadCreateInput): Promise<UploadCreateResult> {
    await this.ensureLoaded()
    await this.purgeExpired()

    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
      throw new UploadError('VALIDATION', '缺少 sessionId')
    }
    const { dir, name } = splitRemotePath(input.remotePath)
    if (typeof input.totalBytes !== 'number' || !Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) {
      throw new UploadError('VALIDATION', 'totalBytes 必须是正整数')
    }
    const chunkSize = requireChunkSize(input.chunkSize, this.defaultChunkSize)
    const totalChunks = Math.ceil(input.totalBytes / chunkSize)
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new UploadError('VALIDATION', `分片数超过上限（${MAX_TOTAL_CHUNKS}）`)
    }
    if (this.uploads.size >= this.maxActiveUploads) {
      throw new UploadError('TOO_MANY_UPLOADS', `活动上传已达上限（${this.maxActiveUploads}），请先完成或取消其他上传`)
    }

    const uploadId = randomUUID()
    const tempPath = `${dir === '/' ? '' : dir}/.dsh-tmp-${uploadId}-${name}`
    const createdAtMs = this.now()
    const sftp = await this.getSftp(input.sessionId)
    const writer = await this.writerFactory(sftp, tempPath, 'w', {})
    const record: UploadRecord = {
      uploadId,
      sessionId: input.sessionId,
      remotePath: input.remotePath,
      tempPath,
      totalBytes: input.totalBytes,
      chunkSize,
      totalChunks,
      receivedOffsets: [],
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      writer,
    }
    this.uploads.set(uploadId, record)
    await this.persist()
    return { uploadId, tempPath, chunkSize, totalChunks }
  }

  /**
   * 写一个分片。分片可乱序、可重发；offset 缺省 = chunkIndex * chunkSize。
   * 分片长度必须精确等于该序号的应有长度（最后一片可短）。
   */
  async writeChunk(uploadId: string, chunkIndex: number, buffer: Buffer | Uint8Array, offset?: number): Promise<UploadChunkResult> {
    await this.ensureLoaded()
    await this.purgeExpired()
    const record = this.requireActive(uploadId)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= record.totalChunks) {
      throw new UploadError('VALIDATION', `chunkIndex 越界（0–${record.totalChunks - 1}）`)
    }
    const span = chunkSpan(chunkIndex, record.chunkSize, record.totalBytes)
    if (offset !== undefined && offset !== span.offset) {
      throw new UploadError('VALIDATION', 'offset 与 chunkIndex 不匹配')
    }
    if (!(buffer instanceof Uint8Array)) throw new UploadError('VALIDATION', '分片内容必须是二进制')
    const bytes = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    if (bytes.length !== span.length) {
      throw new UploadError('VALIDATION', `分片大小不符（期望 ${span.length} 字节，实际 ${bytes.length}）`)
    }

    const writer = await this.ensureWriter(record)
    await writer.write(bytes, span.offset)
    if (!record.receivedOffsets.includes(chunkIndex)) {
      record.receivedOffsets.push(chunkIndex)
      record.receivedOffsets.sort((a, b) => a - b)
    }
    await this.persist()
    return { uploadId, chunkIndex, bytes: bytes.length }
  }

  /** 完成上传：校验分片无空洞 → 关句柄 → rename 落位 → 删记录。 */
  async complete(uploadId: string): Promise<UploadCompleteResult> {
    await this.ensureLoaded()
    await this.purgeExpired()
    const record = this.requireActive(uploadId)
    const received = new Set(record.receivedOffsets)
    const missing: number[] = []
    for (let index = 0; index < record.totalChunks; index++) {
      if (!received.has(index)) missing.push(index)
    }
    if (missing.length > 0) {
      throw new UploadError('VALIDATION', `分片不完整，缺少 ${missing.length} 片（首个: ${missing[0]}）`)
    }

    const sftp = await this.getSftp(record.sessionId)
    if (typeof sftp.replace !== 'function') {
      throw new UploadError('UNSUPPORTED', '该 SFTP 门面不支持分片上传落位')
    }
    const writer = record.writer
    record.writer = undefined
    if (writer !== undefined) await writer.close()
    try {
      await sftp.replace(record.tempPath, record.remotePath)
    } catch (error) {
      record.writer = undefined
      throw error
    }
    this.uploads.delete(uploadId)
    await this.persist()
    return { ok: true, bytes: record.totalBytes, remotePath: record.remotePath }
  }

  /** 查询状态（前端断点续传用）。 */
  async status(uploadId: string): Promise<UploadStatus> {
    await this.ensureLoaded()
    await this.purgeExpired()
    const record = this.requireActive(uploadId)
    return {
      uploadId: record.uploadId,
      remotePath: record.remotePath,
      totalBytes: record.totalBytes,
      chunkSize: record.chunkSize,
      totalChunks: record.totalChunks,
      receivedOffsets: [...record.receivedOffsets],
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    }
  }

  /** 取消上传（幂等）：关句柄、尽力删临时文件、删记录。 */
  async cancel(uploadId: string): Promise<{ ok: true }> {
    await this.ensureLoaded()
    const record = this.uploads.get(uploadId)
    if (record === undefined) return { ok: true }
    await this.discard(record, true)
    await this.persist()
    return { ok: true }
  }

  /** 清理过期会话（定时器 / 启动后首次操作时调用）；返回清理数量。 */
  async purgeExpired(): Promise<number> {
    await this.ensureLoaded()
    const at = this.now()
    const expired = [...this.uploads.values()].filter(record => at >= record.expiresAtMs)
    for (const record of expired) await this.discard(record, true)
    if (expired.length > 0) await this.persist()
    return expired.length
  }

  /** 卸载：停定时器、关全部句柄；不删临时文件（重启后仍可续传）。 */
  async closeAll(): Promise<void> {
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer)
    const writers: UploadWriter[] = []
    for (const record of this.uploads.values()) {
      if (record.writer !== undefined) writers.push(record.writer)
      record.writer = undefined
    }
    this.uploads.clear()
    this.loaded = false
    await Promise.all(writers.map(writer => writer.close().catch(() => {})))
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 懒加载持久化记录（并发调用合并）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading !== undefined) {
      await this.loading
      return
    }
    this.loading = this.loadFromDisk()
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  /** 读 uploads.json；不存在 / 损坏时按空清单安全重建。 */
  private async loadFromDisk(): Promise<void> {
    this.loaded = true
    let text: string
    try {
      text = await readFile(joinLocal(this.dataDir, UPLOADS_FILE_NAME), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const envelope = parsed as { version?: unknown; uploads?: unknown }
    if (envelope.version !== 1 || !Array.isArray(envelope.uploads)) return
    const at = this.now()
    for (const raw of envelope.uploads) {
      const record = parsePersisted(raw)
      if (record === undefined) continue
      // 启动时就丢弃已过期的记录（临时文件随后由 purgeExpired 清理）
      if (at >= record.expiresAtMs) {
        void this.discard(record, true)
        continue
      }
      this.uploads.set(record.uploadId, record)
    }
  }

  /** 持久化（原子写；串行化避免并发 rename 互相覆盖）。失败不打断传输。 */
  private persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      const envelope = {
        version: 1 as const,
        uploads: [...this.uploads.values()].map((record): PersistedUpload => ({
          uploadId: record.uploadId,
          sessionId: record.sessionId,
          remotePath: record.remotePath,
          tempPath: record.tempPath,
          totalBytes: record.totalBytes,
          chunkSize: record.chunkSize,
          totalChunks: record.totalChunks,
          receivedOffsets: [...record.receivedOffsets],
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })),
      }
      try {
        await mkdir(this.dataDir, { recursive: true })
        const target = joinLocal(this.dataDir, UPLOADS_FILE_NAME)
        const temp = `${target}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(envelope), 'utf8')
        await rename(temp, target)
      } catch {
        // 持久化失败只影响重启续传，不影响本次上传
      }
    })
    return this.persistChain
  }

  /** 取一个未过期记录；不存在 / 过期 → NOT_FOUND。 */
  private requireActive(uploadId: string): UploadRecord {
    const record = this.uploads.get(uploadId)
    if (record === undefined) throw new UploadError('NOT_FOUND', '上传会话不存在')
    if (this.now() >= record.expiresAtMs) {
      void this.discard(record, true)
      throw new UploadError('NOT_FOUND', '上传会话已过期')
    }
    return record
  }

  /** 懒打开 / 重开写入句柄；远端临时文件不在则从头开始。 */
  private async ensureWriter(record: UploadRecord): Promise<UploadWriter> {
    if (record.writer !== undefined && !record.writer.props.poisoned) return record.writer
    if (record.writer !== undefined) {
      const stale = record.writer
      record.writer = undefined
      await stale.close().catch(() => {})
    }
    const sftp = await this.getSftp(record.sessionId)
    let mode: 'w' | 'r+' = 'r+'
    try {
      const info = await sftp.stat(record.tempPath)
      if (!info.isFile) {
        mode = 'w'
        record.receivedOffsets = []
      }
    } catch (error) {
      if (error instanceof FileServiceError && error.code === 'NOT_FOUND') {
        mode = 'w'
        record.receivedOffsets = []
      } else {
        throw error
      }
    }
    record.writer = await this.writerFactory(sftp, record.tempPath, mode, {})
    return record.writer
  }

  /** 关句柄（若打开）、删记录、可选删临时文件。 */
  private async discard(record: UploadRecord, removeTemp: boolean): Promise<void> {
    const writer = record.writer
    record.writer = undefined
    this.uploads.delete(record.uploadId)
    if (writer !== undefined) await writer.close().catch(() => {})
    if (!removeTemp) return
    try {
      const sftp = await this.getSftp(record.sessionId)
      await sftp.unlink?.(record.tempPath)
    } catch {
      // 会话已断 / 文件已不在：清理尽力而为
    }
  }
}

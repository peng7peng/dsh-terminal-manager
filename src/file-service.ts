/**
 * B10 文件服务 —— 契约 `src/types/file-service.ts` 的实现。
 *
 * S1：本地四件套（listLocal / readLocal / writeLocal / listDirectories），全部经 path-security 围栏；
 * S5：远端四方法按会话协议分派（SSH → SftpLike 门面；Telnet → UNSUPPORTED）。
 * 目录列表排序改编自 DSH-better-sidebar（MIT）src/fs-tree.ts。
 * @module dsh-terminal-manager/file-service
 */

import { randomBytes } from 'node:crypto'
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FileServiceError, mapFsError } from './file-errors.ts'
import { requireAbsolute, resolveInsideRoot, resolveWritePathInsideRoot } from './path-security.ts'
import type { SftpLike, SftpProgress, SftpPutSource } from './transport/types.ts'
import type { SessionSnapshot } from './types/session-api.ts'
import type { TmEventBus } from './types/events.ts'
import type { FileEntry, FileService, LocalPathRef, ReadResult, TransferProgress, TransferResult, UploadSource } from './types/file-service.ts'

/** 编辑器打开上限（超出只读 + 截断）。 */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024

/** 目录优先，再按名字不分大小写排序（VSCode 资源管理器顺序）。 */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  const aDir = a.kind === 'dir'
  const bDir = b.kind === 'dir'
  if (aDir !== bDir) return aDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * 原子 rename。Windows 上并发写同一目标时 rename 会撞 EPERM/EACCES
 * （目标文件正被另一个 rename 操作占用），短暂退避重试即可——
 * 临时文件还在，竞争是瞬时的。
 */
async function renameAtomic(src: string, dest: string, retries = 6): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dest)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (attempt < retries && (code === 'EPERM' || code === 'EACCES')) {
        await new Promise(r => setTimeout(r, 5 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
}

async function entryOf(dir: string, name: string, dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Promise<FileEntry> {
  const path = join(dir, name)
  if (dirent.isSymbolicLink()) return { name, path, kind: 'symlink' }
  if (dirent.isDirectory()) return { name, path, kind: 'dir' }
  if (dirent.isFile()) {
    try {
      const s = await stat(path)
      return { name, path, kind: 'file', size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return { name, path, kind: 'file' }
    }
  }
  return { name, path, kind: 'other' }
}

/** 远端操作所需的会话侧依赖（index.ts 注入 SessionManager；结构化最小面，测试可注入假实现）。 */
export interface FileSessionGateway {
  /** 会话快照（协议 / 状态判断用） */
  get(sessionId: string): SessionSnapshot | undefined
  /** 取该会话的 SFTP 门面（仅 SSH 会话；SessionManager.getSftp） */
  getSftp(sessionId: string): Promise<SftpLike>
}

/** 本地文件服务实现。 */
export class LocalFileService implements FileService {
  constructor(
    /** 会话池依赖（远端操作用；不注入则远端四方法抛 UNSUPPORTED，本地能力不受影响） */
    private readonly sessions: FileSessionGateway | undefined,
    /** 事件总线（契约 src/types/events.ts；传输结束处 emit `file`事件，成功/失败/取消都发） */
    private readonly events: TmEventBus | undefined,
    private readonly maxReadBytes: number = DEFAULT_MAX_READ_BYTES,
  ) {}

  async listLocal(ref: LocalPathRef): Promise<FileEntry[]> {
    const real = await resolveInsideRoot(ref.root, ref.path)
    let dirents
    try {
      dirents = await readdir(real, { withFileTypes: true })
    } catch (error) {
      throw mapFsError(error, '目录')
    }
    const entries = await Promise.all(dirents.map(d => entryOf(real, d.name, d)))
    return entries.sort(compareEntries)
  }

  async readLocal(ref: LocalPathRef, opts: { maxBytes?: number } = {}): Promise<ReadResult> {
    const real = await resolveInsideRoot(ref.root, ref.path)
    const maxBytes = opts.maxBytes ?? this.maxReadBytes
    let size: number
    try {
      const s = await stat(real)
      if (s.isDirectory()) throw new FileServiceError('VALIDATION', '路径是目录不是文件')
      size = s.size
    } catch (error) {
      throw mapFsError(error, '文件')
    }
    try {
      if (size <= maxBytes) {
        return { content: await readFile(real, 'utf8'), size, truncated: false }
      }
      const fh = await open(real, 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
        return { content: buf.subarray(0, bytesRead).toString('utf8'), size, truncated: true }
      } finally {
        await fh.close()
      }
    } catch (error) {
      throw mapFsError(error, '文件')
    }
  }

  async writeLocal(ref: LocalPathRef, content: string): Promise<{ bytes: number }> {
    const { path, missingSegments } = await resolveWritePathInsideRoot(ref.root, ref.path)
    if (missingSegments.length > 1) throw new FileServiceError('NOT_FOUND', '父目录不存在（不自动创建目录）')
    if (missingSegments.length === 0) {
      try {
        if ((await stat(path)).isDirectory()) throw new FileServiceError('VALIDATION', '路径是目录不是文件')
      } catch (error) {
        throw mapFsError(error, '文件')
      }
    }
    const tmp = join(dirname(path), `.${basename(path)}.tm-tmp-${randomBytes(4).toString('hex')}`)
    try {
      await writeFile(tmp, content, 'utf8')
      await renameAtomic(tmp, path)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw mapFsError(error, '文件')
    }
    return { bytes: Buffer.byteLength(content, 'utf8') }
  }

  async listDirectories(absPath: string): Promise<FileEntry[]> {
    const path = requireAbsolute(absPath)
    let dirents
    try {
      dirents = await readdir(path, { withFileTypes: true })
    } catch (error) {
      throw mapFsError(error, '目录')
    }
    return dirents
      .filter(d => d.isDirectory())
      .map((d): FileEntry => ({ name: d.name, path: join(path, d.name), kind: 'dir' }))
      .sort(compareEntries)
  }

  // ── 远端（S5，按会话协议分派：SSH → SFTP 门面；Telnet → UNSUPPORTED，base64 模拟已砍）──

  /**
   * 远端操作前置分派：会话存在 → open → SSH → 拿 SFTP 门面。
   * 无 SESSION_BUSY 锁：SFTP 是 SSH 独立子通道，不碰 PTY 字节流，与终端交互互不干扰。
   * 传输层错误映射：DISCONNECTED 保留，其余归 REMOTE_IO。
   */
  private async requireSftp(sessionId: string): Promise<SftpLike> {
    if (this.sessions === undefined) throw new FileServiceError('UNSUPPORTED', '文件服务未接入会话池（远端操作不可用）')
    const snap = this.sessions.get(sessionId)
    if (snap === undefined) throw new FileServiceError('SESSION_NOT_FOUND', `会话不存在: ${sessionId}`)
    if (snap.status !== 'open') throw new FileServiceError('DISCONNECTED', '会话已断开')
    if (snap.protocol !== 'ssh') throw new FileServiceError('UNSUPPORTED', 'Telnet 会话不支持文件传输（仅 SSH/SFTP）')
    try {
      return await this.sessions.getSftp(sessionId)
    } catch (error) {
      // TransportError / SessionError 都带 code 字段，按码映射即可
      if ((error as { code?: string } | undefined)?.code === 'DISCONNECTED') {
        throw new FileServiceError('DISCONNECTED', 'SSH 连接已断开，无法进行文件操作', { cause: error })
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new FileServiceError('REMOTE_IO', `打开 SFTP 通道失败: ${message}`, { cause: error })
    }
  }

  async listRemote(req: { sessionId: string; path: string }): Promise<FileEntry[]> {
    const sftp = await this.requireSftp(req.sessionId)
    // 与本地面板一致：目录在前、名字不分大小写（门面按 readdir 原序返回）
    return (await sftp.list(req.path)).sort(compareEntries)
  }

  async upload(req: { sessionId: string; remotePath: string; source: UploadSource; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> {
    const sftp = await this.requireSftp(req.sessionId)
    const started = Date.now()
    try {
      // 树根围栏：local 来源的文件必须在本地面板当前树根内
      const source: SftpPutSource = req.source.kind === 'local'
        ? { kind: 'path', path: await resolveInsideRoot(req.source.ref.root, req.source.ref.path) }
        : {
          kind: 'stream',
          stream: req.source.stream,
          ...(req.source.size !== undefined ? { size: req.source.size } : {}),
        }
      const { onProgress, transferred } = this.progressMapper('upload', req.sessionId, req.remotePath, req.onProgress)
      const { bytes } = await sftp.put(source, req.remotePath, { ...(onProgress !== undefined ? { onProgress } : {}) })
      this.emitFile(req.sessionId, 'upload', req.remotePath, true, bytes)
      return { ok: true, bytes, durationMs: Date.now() - started }
    } catch (error) {
      this.emitFile(req.sessionId, 'upload', req.remotePath, false, undefined, error)
      throw error
    }
  }

  async download(req: { sessionId: string; remotePath: string; onProgress?: (p: TransferProgress) => void }): Promise<{ stream: import('node:stream').Readable; size?: number }> {
    const sftp = await this.requireSftp(req.sessionId)
    const { onProgress, transferred } = this.progressMapper('download', req.sessionId, req.remotePath, req.onProgress)
    const { stream, size } = await sftp.downloadStream(req.remotePath, { ...(onProgress !== undefined ? { onProgress } : {}) })
    this.watchStreamEnd(req.sessionId, req.remotePath, stream, transferred)
    return { stream, ...(size !== undefined ? { size } : {}) }
  }

  async downloadToLocal(req: { sessionId: string; remotePath: string; target: LocalPathRef; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> {
    const sftp = await this.requireSftp(req.sessionId)
    const started = Date.now()
    let temp: string | undefined
    try {
      // 围栏：目标必须在本地面板当前树根内（可尚不存在，父目录存在即可）
      const { path: targetPath, missingSegments } = await resolveWritePathInsideRoot(req.target.root, req.target.path)
      if (missingSegments.length > 1) throw new FileServiceError('NOT_FOUND', '父目录不存在（不自动创建目录）')
      // 本地半成品保护：先下到同目录临时文件再改名，中断/失败自动清理、旧文件不受影响
      temp = join(dirname(targetPath), `.${basename(targetPath)}.tm-partial-${randomBytes(4).toString('hex')}`)
      const { onProgress } = this.progressMapper('download', req.sessionId, req.remotePath, req.onProgress)
      const { bytes } = await sftp.get(req.remotePath, temp, { ...(onProgress !== undefined ? { onProgress } : {}) })
      await rename(temp, targetPath)
      this.emitFile(req.sessionId, 'download', req.remotePath, true, bytes)
      return { ok: true, bytes, durationMs: Date.now() - started }
    } catch (error) {
      if (temp !== undefined) await unlink(temp).catch(() => {})
      this.emitFile(req.sessionId, 'download', req.remotePath, false, undefined, error)
      throw error
    }
  }

  // ── 远端辅助 ──────────────────────────────────────────

  /** 把 SftpProgress 转成契约 TransferProgress 回调；transferred() 取终值（供结束事件的 bytes）。 */
  private progressMapper(
    op: 'upload' | 'download',
    sessionId: string,
    remotePath: string,
    cb?: (p: TransferProgress) => void,
  ): { onProgress?: SftpProgress; transferred: () => number } {
    let transferred = 0
    if (cb === undefined) return { transferred: () => transferred }
    return {
      onProgress: (t, total) => {
        transferred = t
        cb({
          op,
          sessionId,
          remotePath,
          transferred: t,
          ...(total !== undefined ? { total } : {}),
          ...(total > 0 ? { percent: Math.min(100, Math.round((t / total) * 100)) } : {}),
        })
      },
      transferred: () => transferred,
    }
  }

  /** 流式下载的结束事件：end=成功；error=失败；close 而未 end=被取消（如 HTTP 响应中止）。 */
  private watchStreamEnd(
    sessionId: string,
    remotePath: string,
    stream: import('node:stream').Readable,
    transferred: () => number,
  ): void {
    let settled = false
    stream.once('end', () => {
      if (settled) return
      settled = true
      this.emitFile(sessionId, 'download', remotePath, true, transferred())
    })
    stream.once('error', (error: unknown) => {
      if (settled) return
      settled = true
      this.emitFile(sessionId, 'download', remotePath, false, undefined, error)
    })
    stream.once('close', () => {
      if (settled) return
      settled = true
      this.emitFile(sessionId, 'download', remotePath, false, undefined, new Error('传输被取消'))
    })
  }

  /** 传输结束事件（成功/失败/取消都发；path = 远端路径，upload=目标 / download=源）。 */
  private emitFile(sessionId: string, op: 'upload' | 'download', path: string, ok: boolean, bytes?: number, error?: unknown): void {
    this.events?.emit({
      type: 'file',
      sessionId,
      op,
      path,
      ok,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
      ts: Date.now(),
    })
  }
}

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
import type { SftpLike } from './transport/types.ts'
import type { SessionSnapshot } from './types/session-api.ts'
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

function unsupported(): never {
  throw new FileServiceError('UNSUPPORTED', '远端文件操作尚未实现（S5）')
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
      await rename(tmp, path)
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
    await this.requireSftp(req.sessionId)
    return unsupported() // 步骤 4 实装
  }

  async upload(req: { sessionId: string; remotePath: string; source: UploadSource; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> {
    await this.requireSftp(req.sessionId)
    return unsupported() // 步骤 4 实装
  }

  async download(req: { sessionId: string; remotePath: string; onProgress?: (p: TransferProgress) => void }): Promise<{ stream: import('node:stream').Readable; size?: number }> {
    await this.requireSftp(req.sessionId)
    return unsupported() // 步骤 4 实装
  }

  async downloadToLocal(req: { sessionId: string; remotePath: string; target: LocalPathRef; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> {
    await this.requireSftp(req.sessionId)
    return unsupported() // 步骤 4 实装
  }
}

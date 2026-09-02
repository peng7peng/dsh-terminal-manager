/**
 * B10 文件服务 —— 契约 `src/types/file-service.ts` 的实现。
 *
 * S1：本地四件套（listLocal / readLocal / writeLocal / listDirectories），全部经 path-security 围栏；
 * S5：远端四方法（SFTP / Telnet 模拟），当前一律抛 UNSUPPORTED。
 * 目录列表排序改编自 DSH-better-sidebar（MIT）src/fs-tree.ts。
 * @module dsh-terminal-manager/file-service
 */

import { randomBytes } from 'node:crypto'
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FileServiceError, mapFsError } from './file-errors.ts'
import { requireAbsolute, resolveInsideRoot, resolveWritePathInsideRoot } from './path-security.ts'
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

/** 本地文件服务实现。 */
export class LocalFileService implements FileService {
  constructor(private readonly maxReadBytes: number = DEFAULT_MAX_READ_BYTES) {}

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

  // ── 远端（S5）──
  async listRemote(_req: { sessionId: string; path: string }): Promise<FileEntry[]> { return unsupported() }
  async upload(_req: { sessionId: string; remotePath: string; source: UploadSource; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> { return unsupported() }
  async download(_req: { sessionId: string; remotePath: string; onProgress?: (p: TransferProgress) => void }): Promise<{ stream: import('node:stream').Readable; size?: number }> { return unsupported() }
  async downloadToLocal(_req: { sessionId: string; remotePath: string; target: LocalPathRef; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult> { return unsupported() }
}

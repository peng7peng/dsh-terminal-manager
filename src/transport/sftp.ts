/**
 * SFTP 门面 —— 把 ssh2 的 SFTPWrapper 包装成文件服务远端操作需要的原语：
 * list / stat / mkdirs / put / get / downloadStream。
 * 上传统一先写远端临时文件（`<目标>.tm-partial-<rand>`）再改名：成功才落地，中断 / 失败自动清理半成品。
 * 进度回调节流 200ms，传输结束补发一次终值。
 * 所有错误统一映射为 FileServiceError（见 mapSftpError）。
 * @module dsh-terminal-manager/transport/sftp
 */

import { randomBytes } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { utils, type SFTPWrapper, type TransferOptions } from 'ssh2'
import { FileServiceError } from '../file-errors.ts'
import type { FileEntry } from '../types/file-service.ts'
import type { SftpLike, SftpProgress, SftpPutSource, SftpStatInfo, SftpTransferOptions } from './types.ts'

const { STATUS_CODE, OPEN_MODE } = utils.sftp

// SftpProgress / SftpStatInfo / SftpPutSource / SftpTransferOptions / SftpLike 声明在 transport/types.ts（协议无关）

const PROGRESS_THROTTLE_MS = 200

/**
 * ssh2 SFTP 错误 → 统一错误码：
 * NO_SUCH_FILE → NOT_FOUND；PERMISSION_DENIED → VALIDATION；
 * NO_CONNECTION / CONNECTION_LOST（连接已断）→ DISCONNECTED；其余 → REMOTE_IO。
 * FileServiceError 原样透传。message 只描述问题，不含凭据。
 */
export function mapSftpError(err: unknown, what: string): FileServiceError {
  if (err instanceof FileServiceError) return err
  const code = (err as { code?: number } | undefined)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === STATUS_CODE.NO_SUCH_FILE) return new FileServiceError('NOT_FOUND', `${what}不存在`, { cause: err })
  if (code === STATUS_CODE.PERMISSION_DENIED) return new FileServiceError('VALIDATION', `${what}没有访问权限`, { cause: err })
  if (code === STATUS_CODE.NO_CONNECTION || code === STATUS_CODE.CONNECTION_LOST || /not connected/i.test(message)) {
    return new FileServiceError('DISCONNECTED', `SSH 连接已断开，${what}无法继续`, { cause: err })
  }
  return new FileServiceError('REMOTE_IO', `${what}失败: ${message}`, { cause: err })
}

/** 节流包装：至少间隔 PROGRESS_THROTTLE_MS 才透传一次（首值立即透传；终值由调用方补发） */
function throttleProgress(onProgress?: SftpProgress): SftpProgress | undefined {
  if (!onProgress) return undefined
  let last = 0
  return (transferred, total) => {
    const now = Date.now()
    if (now - last >= PROGRESS_THROTTLE_MS) {
      last = now
      onProgress(transferred, total)
    }
  }
}

/** 远端路径拼接（SFTP 统一 POSIX 斜杠风格） */
function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export class SftpFacade implements SftpLike {
  constructor(private readonly sftp: SFTPWrapper) {}

  /** 列一层目录（属性按 readdir 返回，符号链接不跟随） */
  list(path: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(path, (err, infos) => {
        if (err) {
          reject(mapSftpError(err, `列目录 ${path}`))
          return
        }
        resolve(
          infos.map((fi) => {
            const kind = fi.attrs.isDirectory()
              ? 'dir'
              : fi.attrs.isSymbolicLink()
                ? 'symlink'
                : fi.attrs.isFile()
                  ? 'file'
                  : 'other'
            return {
              name: fi.filename,
              path: joinRemote(path, fi.filename),
              kind,
              ...(typeof fi.attrs.size === 'number' ? { size: fi.attrs.size } : {}),
              ...(typeof fi.attrs.mtime === 'number' ? { mtimeMs: fi.attrs.mtime * 1000 } : {}),
            }
          }),
        )
      })
    })
  }

  /** 单个路径的信息（lstat 语义） */
  stat(path: string): Promise<SftpStatInfo> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, st) => {
        if (err) {
          reject(mapSftpError(err, `读取信息 ${path}`))
          return
        }
        resolve({
          isDirectory: st.isDirectory(),
          isFile: st.isFile(),
          isSymlink: st.isSymbolicLink(),
          ...(typeof st.size === 'number' ? { size: st.size } : {}),
          ...(typeof st.mtime === 'number' ? { mtimeMs: st.mtime * 1000 } : {}),
        })
      })
    })
  }

  /** 逐级建目录（已存在且是目录则跳过；中间有同名非目录则 REMOTE_IO） */
  async mkdirs(path: string): Promise<void> {
    const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!norm) throw new FileServiceError('VALIDATION', '远端目录路径不能为空')
    if (norm === '/') return
    let cur = ''
    for (const part of norm.split('/')) {
      cur += `/${part}`
      let st: SftpStatInfo | undefined
      try {
        st = await this.statFollowed(cur)
      } catch (err) {
        if ((err as FileServiceError).code !== 'NOT_FOUND') throw err
      }
      if (st) {
        if (!st.isDirectory) throw new FileServiceError('REMOTE_IO', `${cur}已存在且不是目录`)
        continue
      }
      await new Promise<void>((resolve, reject) => {
        this.sftp.mkdir(cur, (err) => (err ? reject(mapSftpError(err, `创建目录 ${cur}`)) : resolve()))
      })
    }
  }

  /**
   * 上传：先写远端临时文件 `<目标>.tm-partial-<rand>`，成功后改名到目标；
   * 中断 / 失败清理临时文件（半成品），目标上的旧文件不受影响。
   * 目标已存在时覆盖（同名冲突由上层 UI 先问过用户）。
   */
  async put(source: SftpPutSource, remotePath: string, opts: SftpTransferOptions = {}): Promise<{ bytes: number }> {
    if (!remotePath || remotePath.includes('\0')) throw new FileServiceError('VALIDATION', '远端路径不能为空')
    const temp = `${remotePath}.tm-partial-${randomBytes(4).toString('hex')}`
    try {
      const bytes = source.kind === 'path'
        ? await this.fastPutToTemp(source.path, temp, opts.onProgress)
        : await this.pumpStreamToTemp(source.stream, temp, source.size, opts.onProgress)
      await this.place(temp, remotePath)
      return { bytes }
    } catch (err) {
      await this.unlinkQuietly(temp)
      throw mapSftpError(err, `上传 ${remotePath}`)
    }
  }

  /** 下载到本地路径（fastGet）。maxBytes 超限抛 FILE_TOO_LARGE */
  async get(remotePath: string, localPath: string, opts: SftpTransferOptions = {}): Promise<{ bytes: number; size?: number }> {
    const size = await this.requireFileSize(remotePath, opts.maxBytes)
    const throttled = throttleProgress(opts.onProgress)
    let transferred = 0
    await new Promise<void>((resolve, reject) => {
      const options: TransferOptions = {
        step: (done: number) => {
          transferred = done
          throttled?.(done, size)
        },
      }
      this.sftp.fastGet(remotePath, localPath, options, (err) => (err ? reject(mapSftpError(err, `下载 ${remotePath}`)) : resolve()))
    })
    opts.onProgress?.(transferred, size)
    return { bytes: transferred, size }
  }

  /** 下载成流（HTTP 路由直接管响应）。错误经 destroy 传播到返回的流上 */
  async downloadStream(remotePath: string, opts: SftpTransferOptions = {}): Promise<{ stream: Readable; size?: number }> {
    const size = await this.requireFileSize(remotePath, opts.maxBytes)
    const throttled = throttleProgress(opts.onProgress)
    let transferred = 0
    const out = new PassThrough()
    const rs = this.sftp.createReadStream(remotePath)
    rs.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      throttled?.(transferred, size)
    })
    rs.on('end', () => opts.onProgress?.(transferred, size))
    rs.on('error', (err: unknown) => out.destroy(mapSftpError(err, `下载 ${remotePath}`)))
    // 消费端中止（浏览器取消下载 / 响应断开）→ 停止从设备拉数据（审查 M1：否则整个文件后台拉完）
    out.on('close', () => { if (!rs.readableEnded) rs.destroy() })
    rs.pipe(out)
    return { stream: out, ...(size !== undefined ? { size } : {}) }
  }

  // ── 内部 ──────────────────────────────────────────────

  /** stat（跟随符号链接；mkdirs 探测用） */
  private statFollowed(path: string): Promise<SftpStatInfo> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err, st) => {
        if (err) {
          reject(mapSftpError(err, `读取信息 ${path}`))
          return
        }
        resolve({
          isDirectory: st.isDirectory(),
          isFile: st.isFile(),
          isSymlink: st.isSymbolicLink(),
          ...(typeof st.size === 'number' ? { size: st.size } : {}),
        })
      })
    })
  }

  /** 先 stat 校验存在性与大小上限，返回已知大小 */
  private async requireFileSize(remotePath: string, maxBytes?: number): Promise<number | undefined> {
    const st = await this.stat(remotePath)
    if (st.isDirectory) throw new FileServiceError('VALIDATION', `${remotePath}是目录，请先打包再传输`)
    if (maxBytes !== undefined && st.size !== undefined && st.size > maxBytes) {
      throw new FileServiceError('FILE_TOO_LARGE', `${remotePath}超过传输上限 ${maxBytes} 字节`)
    }
    return st.size
  }

  /** fastPut 到临时文件，返回已传输字节（错误原样抛出，由 put 统一映射） */
  private fastPutToTemp(localPath: string, temp: string, onProgress?: SftpProgress): Promise<number> {
    const throttled = throttleProgress(onProgress)
    let transferred = 0
    return new Promise<number>((resolve, reject) => {
      this.sftp.fastPut(localPath, temp, {
        step: (done: number, _chunk: number, fsize: number) => {
          transferred = done
          throttled?.(done, fsize > 0 ? fsize : undefined)
        },
      }, (err) => (err ? reject(err) : resolve(transferred)))
    })
  }

  /** 流式上传到临时文件，返回已传输字节 */
  private async pumpStreamToTemp(stream: Readable, temp: string, size: number | undefined, onProgress?: SftpProgress): Promise<number> {
    const throttled = throttleProgress(onProgress)
    let transferred = 0
    stream.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      throttled?.(transferred, size)
    })
    const ws = this.sftp.createWriteStream(temp)
    await pipeline(stream, ws)
    onProgress?.(transferred, size)
    return transferred
  }

  /** 临时文件落到目标：先直接改名；SFTP v3 rename 不覆盖已存在目标，失败则删旧再改 */
  private async place(temp: string, remotePath: string): Promise<void> {
    try {
      await this.rename(temp, remotePath)
    } catch {
      await this.unlinkQuietly(remotePath)
      await this.rename(temp, remotePath)
    }
  }

  private rename(from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** 删除文件；NOT_FOUND 静默忽略，其余错误也静默（清理路径不打断主流程） */
  private async unlinkQuietly(path: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
      })
    } catch {
      // 清理失败不抛：主流程的错误更有价值
    }
  }
}

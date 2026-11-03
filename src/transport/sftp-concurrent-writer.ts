/**
 * SFTP 并发写 —— 大文件分片上传的底层写入器。
 *
 * 一个 `write(buffer, position)` 调用把 buffer 拆成 256 KiB 子包，最多 32 路并发
 * 发到同一个 SFTP 句柄的 position-based `pwrite`。整体有绝对超时（默认 60 秒，
 * 环境变量 `TM_SFTP_WRITE_TIMEOUT_MS` 可覆盖）：超时或任一子包失败即置 `poisoned`，
 * 之后所有 write 直接拒绝（避免在未知的故障句柄上继续写坏数据）。
 *
 * 句柄由 `SftpLike.openWrite` 打开；测试可直接用构造函数注入假句柄。
 * @module dsh-terminal-manager/transport/sftp-concurrent-writer
 */

import { FileServiceError } from '../file-errors.ts'
import type { SftpLike, SftpWriteHandle } from './types.ts'

/** 子包大小：256 KiB（SFTP 协议单次写请求过大时会显著拖慢，小包 + 并发更快）。 */
export const DEFAULT_SUBPACKET_BYTES = 256 * 1024
/** 单次 write 的子包并发上限。 */
export const DEFAULT_WRITE_CONCURRENCY = 32
/** 单次 write 的绝对超时（毫秒）。 */
export const DEFAULT_WRITE_TIMEOUT_MS = 60_000

export interface SftpConcurrentWriterOptions {
  /** 绝对超时（毫秒）；缺省读 `TM_SFTP_WRITE_TIMEOUT_MS`，再缺省 60s */
  timeoutMs?: number
  /** 子包大小（默认 256 KiB） */
  subPacketBytes?: number
  /** 子包并发（默认 32） */
  concurrency?: number
}

/** 从环境变量读超时；非法值回退默认。 */
function timeoutFromEnv(): number {
  const raw = process.env.TM_SFTP_WRITE_TIMEOUT_MS
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_WRITE_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WRITE_TIMEOUT_MS
}

/** 把任意错误统一成 FileServiceError（FileServiceError 原样透传）。 */
function writerError(error: unknown, what: string): FileServiceError {
  if (error instanceof FileServiceError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new FileServiceError('REMOTE_IO', `${what}失败: ${message}`, { cause: error })
}

/** 绝对超时：到点 reject；原 promise 完成时清掉定时器。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FileServiceError('REMOTE_IO', `SFTP 写入超时（超过 ${timeoutMs}ms 未完成）`))
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** 固定并发跑一组任务；任一失败后其余 worker 不再领新任务。 */
async function runPool(tasks: ReadonlyArray<() => Promise<void>>, concurrency: number): Promise<void> {
  let cursor = 0
  let failed = false
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, async () => {
    for (;;) {
      if (failed) return
      const index = cursor++
      if (index >= tasks.length) return
      try {
        await tasks[index]!()
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  await Promise.all(workers)
}

/**
 * 基于 SFTP 句柄的并发写入器。
 * 生命周期：`open` → 多次 `write` → `close`（幂等）。
 */
export class SftpConcurrentWriter {
  private readonly subPacketBytes: number
  private readonly concurrency: number
  private readonly timeoutMs: number
  private closed = false
  private failed = false
  private handle: SftpWriteHandle | undefined

  constructor(handle: SftpWriteHandle, options: SftpConcurrentWriterOptions = {}) {
    this.handle = handle
    this.subPacketBytes = options.subPacketBytes ?? DEFAULT_SUBPACKET_BYTES
    this.concurrency = options.concurrency ?? DEFAULT_WRITE_CONCURRENCY
    this.timeoutMs = options.timeoutMs ?? timeoutFromEnv()
  }

  /** 打开远端文件并返回写入器（mode='w' 截断新建；'r+' 保留已有内容续传）。 */
  static async open(sftp: Pick<SftpLike, 'openWrite'>, path: string, options: SftpConcurrentWriterOptions & { mode?: 'w' | 'r+' } = {}): Promise<SftpConcurrentWriter> {
    if (typeof sftp.openWrite !== 'function') {
      throw new FileServiceError('UNSUPPORTED', '该 SFTP 门面不支持分片写入')
    }
    const handle = await sftp.openWrite(path, options.mode ?? 'w')
    return new SftpConcurrentWriter(handle, options)
  }

  /** 句柄状态（poisoned = 已因超时/失败失效，不能再写）。 */
  get props(): { poisoned: boolean } {
    return { poisoned: this.failed }
  }

  /**
   * 在 position 处写入 buffer：拆 256 KiB 子包、并发 pwrite。
   * 超时/失败会 poison 写入器；之后调用直接失败。
   */
  async write(buffer: Buffer, position: number): Promise<void> {
    if (this.closed) throw new FileServiceError('REMOTE_IO', 'SFTP 写入句柄已关闭')
    if (this.failed) throw new FileServiceError('REMOTE_IO', 'SFTP 写入句柄已失效，无法继续写入')
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new FileServiceError('VALIDATION', '写入位置必须是非负整数')
    }
    if (buffer.length === 0) return
    const handle = this.handle
    if (handle === undefined) throw new FileServiceError('REMOTE_IO', 'SFTP 写入句柄已关闭')

    const tasks: Array<() => Promise<void>> = []
    for (let offset = 0; offset < buffer.length; offset += this.subPacketBytes) {
      const end = Math.min(offset + this.subPacketBytes, buffer.length)
      const slice = buffer.subarray(offset, end)
      const at = position + offset
      tasks.push(() => handle.write(slice, at))
    }

    try {
      await withTimeout(runPool(tasks, this.concurrency), this.timeoutMs)
    } catch (error) {
      this.failed = true
      throw writerError(error, 'SFTP 分片写入')
    }
  }

  /** 关闭句柄（幂等；关闭失败静默——临时文件可被重新打开或清理）。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const handle = this.handle
    this.handle = undefined
    if (handle === undefined) return
    try {
      await handle.close()
    } catch {
      // 清理路径不打断主流程
    }
  }
}

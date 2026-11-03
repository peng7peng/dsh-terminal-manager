/**
 * 浏览器半 —— 大文件分片上传（断点续传）。
 *
 * 只对 ≥100 MiB 的文件启用（小文件继续走 `POST /files/upload` 的 raw 直传）：
 * - `POST /files/upload/chunked/create` 建会话（4 MiB 分片）；
 * - 有限并发（默认 2）逐片 `POST .../chunk?uploadId&chunkIndex` 发 raw 字节；
 * - 全部到齐后 `POST .../complete` 由后端 rename 落位；
 * - 已知 uploadId 时先 `GET .../status`，跳过 `receivedOffsets` 实现续传；
 * - 失败按有限次重试（只重试网络 / 5xx，业务错误直接抛出）。
 *
 * 依赖全部可注入（fetch / readChunk / now / uuid / resume store），便于单测。
 * @module dsh-terminal-manager/client/files/chunkedUpload
 */

/** 触发分片上传的文件大小阈值：100 MiB。 */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 100 * 1024 * 1024
/** 分片大小：4 MiB（与服务端默认一致）。 */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024
/** 并发发送的分片数（有限并发，避免浏览器连接被单文件占满）。 */
export const CHUNK_CONCURRENCY = 2
/** 单分片失败重试次数。 */
export const CHUNK_MAX_RETRIES = 2

const UPLOAD_BASE = '/api/term-manager/files/upload/chunked'

/** 可切片的最小文件面（File / Blob 结构兼容）。 */
export interface ChunkSource {
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** 最小 fetch 面（测试注入；浏览器 / Node 的 fetch 结构兼容）。 */
export interface FetchLike {
  (input: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: BodyInit | Uint8Array
    signal?: AbortSignal
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

/** 断点续传的记录面（默认进程内 Map；测试可注入）。 */
export interface ResumeStore {
  get(key: string): string | undefined
  set(key: string, uploadId: string): void
  delete(key: string): void
}

/** 分片区间。 */
export interface ChunkRange {
  offset: number
  length: number
}

export interface ChunkedUploadOptions {
  sessionId: string
  remotePath: string
  file: ChunkSource
  /** 发送实现；缺省 globalThis.fetch */
  fetch?: FetchLike
  /** 读文件切片；缺省 file.slice(...).arrayBuffer() */
  readChunk?: (file: ChunkSource, start: number, end: number) => Promise<Uint8Array>
  /** 进度（transferred / total 均为字节） */
  onProgress?: (transferred: number, total: number) => void
  /** 取消信号（中止在途请求；已落盘的分片仍可用于下次续传） */
  signal?: AbortSignal
  /** 分片大小；缺省 4 MiB（服务端 create 返回值为准） */
  chunkSize?: number
  /** 并发；缺省 2（上限 4） */
  concurrency?: number
  /** 单分片重试次数；缺省 2 */
  maxRetries?: number
  /** 当前时间（测试注入） */
  now?: () => number
  /** 断点续传记录；缺省进程内 Map */
  resume?: ResumeStore
  /** 直接指定 uploadId（调用方已知；否则查 resume store） */
  uploadId?: string
}

export interface ChunkedUploadResult {
  uploadId: string
  bytes: number
  remotePath: string
}

interface UploadStatusBody {
  uploadId: string
  remotePath: string
  totalBytes: number
  chunkSize: number
  totalChunks: number
  receivedOffsets: number[]
  createdAtMs: number
  expiresAtMs: number
}

interface CreateBody {
  uploadId: string
  tempPath: string
  chunkSize: number
  totalChunks: number
}

// ── 纯函数 ──

/** 是否达到分片阈值（≥100 MiB）。 */
export function isChunkedUploadEligible(size: number): boolean {
  return Number.isFinite(size) && size >= CHUNKED_UPLOAD_THRESHOLD_BYTES
}

/** 第 index 片的字节区间（最后一片可短）。 */
export function chunkRange(index: number, chunkSize: number, totalBytes: number): ChunkRange {
  const offset = index * chunkSize
  return { offset, length: Math.max(0, Math.min(chunkSize, totalBytes - offset)) }
}

/** 尚未收到的分片序号（升序）。 */
export function missingChunkIndexes(received: readonly number[], totalChunks: number): number[] {
  const have = new Set(received)
  const missing: number[] = []
  for (let index = 0; index < totalChunks; index++) {
    if (!have.has(index)) missing.push(index)
  }
  return missing
}

/** 续传键：同一会话 + 同一远端路径 + 同一大小才复用 uploadId。 */
export function resumeKey(sessionId: string, remotePath: string, totalBytes: number): string {
  return `${sessionId}|${remotePath}|${totalBytes}`
}

// ── 缺省实现 ──

const memoryResume = new Map<string, string>()
const defaultResumeStore: ResumeStore = {
  get: key => memoryResume.get(key),
  set: (key, id) => { memoryResume.set(key, id) },
  delete: key => { memoryResume.delete(key) },
}

async function defaultReadChunk(file: ChunkSource, start: number, end: number): Promise<Uint8Array> {
  const blob = file.slice(start, end)
  return new Uint8Array(await blob.arrayBuffer())
}

/** 取消错误（统一成可读消息，前端 toast 直接显示）。 */
function cancelledError(): Error {
  return new Error('CANCELLED: 上传已取消')
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  return error instanceof Error && (error.name === 'AbortError' || error.message.startsWith('CANCELLED:'))
}

/** 业务错误（后端 {code,message}）→ `CODE: message`；网络错误 → `NETWORK: ...`。 */
async function callJson<T>(
  fetchFn: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  action: string,
): Promise<T> {
  let response: { ok: boolean; status: number; json(): Promise<unknown> }
  try {
    response = await fetchFn(url, init)
  } catch (error) {
    if (isAbortError(error, init?.signal)) throw cancelledError()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`NETWORK: ${action}请求失败（${message}）`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (!response.ok) throw new Error(`HTTP_${response.status}: ${action}失败`)
    throw new Error(`HTTP_${response.status}: ${action}响应不是 JSON`)
  }
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as {
    ok?: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }
  if (response.ok && envelope.ok === true) return envelope.value as T
  if (envelope.error !== undefined) {
    const code = envelope.error.code ?? 'REMOTE_IO'
    throw new Error(`${code}: ${envelope.error.message ?? `${action}失败`}`)
  }
  throw new Error(`HTTP_${response.status}: ${action}失败`)
}

/** 只重试网络 / 5xx（分片内容错了重试也不会好）。 */
function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('NETWORK:') || /^HTTP_5\d\d:/.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 上传一个大文件（分片 + 断点续传）。
 * 成功返回 `{uploadId, bytes, remotePath}`；失败抛出 `CODE: message` 形式的 Error。
 */
export async function uploadLargeFile(options: ChunkedUploadOptions): Promise<ChunkedUploadResult> {
  const { sessionId, remotePath, file } = options
  if (sessionId.length === 0) throw new Error('VALIDATION: 缺少 sessionId')
  if (!remotePath.startsWith('/')) throw new Error('VALIDATION: remotePath 必须是绝对路径')
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('VALIDATION: 文件大小非法')

  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (fetchFn === undefined) throw new Error('NETWORK: 当前环境不支持 fetch')
  const readChunk = options.readChunk ?? defaultReadChunk
  const now = options.now ?? Date.now
  const resume = options.resume ?? defaultResumeStore
  const concurrency = Math.min(4, Math.max(1, options.concurrency ?? CHUNK_CONCURRENCY))
  const maxRetries = Math.max(0, options.maxRetries ?? CHUNK_MAX_RETRIES)
  const key = resumeKey(sessionId, remotePath, file.size)
  const signal = options.signal
  if (signal?.aborted === true) throw cancelledError()

  // 1. 已有 uploadId → status 续传；不匹配 / 过期则重新 create
  let status: UploadStatusBody | undefined
  const known = options.uploadId ?? resume.get(key)
  if (known !== undefined && known.length > 0) {
    try {
      const probed = await callJson<UploadStatusBody>(
        fetchFn,
        `${UPLOAD_BASE}/status?uploadId=${encodeURIComponent(known)}`,
        { method: 'GET', ...(signal !== undefined ? { signal } : {}) },
        '查询上传状态',
      )
      if (probed.remotePath === remotePath && probed.totalBytes === file.size) {
        status = probed
        resume.set(key, probed.uploadId)
      } else {
        resume.delete(key)
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw cancelledError()
      resume.delete(key)
    }
  }

  // 2. 新建会话
  if (status === undefined) {
    const requestedChunkSize = options.chunkSize ?? CHUNK_SIZE_BYTES
    const created = await callJson<CreateBody>(
      fetchFn,
      `${UPLOAD_BASE}/create`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, remotePath, totalBytes: file.size, chunkSize: requestedChunkSize }),
        ...(signal !== undefined ? { signal } : {}),
      },
      '创建上传会话',
    )
    status = {
      uploadId: created.uploadId,
      remotePath,
      totalBytes: file.size,
      chunkSize: created.chunkSize,
      totalChunks: created.totalChunks,
      receivedOffsets: [],
      createdAtMs: now(),
      expiresAtMs: 0,
    }
  }
  resume.set(key, status.uploadId)

  const chunkSize = status.chunkSize
  const totalChunks = status.totalChunks
  const received = new Set(status.receivedOffsets.filter(index => Number.isInteger(index) && index >= 0 && index < totalChunks))
  const missing = missingChunkIndexes([...received], totalChunks)

  // 3. 进度基数 = 已收到的分片字节（续传时从中间开始显示）
  let transferred = 0
  for (const index of received) transferred += chunkRange(index, chunkSize, file.size).length
  options.onProgress?.(transferred, file.size)

  const sendChunk = async (index: number): Promise<void> => {
    const range = chunkRange(index, chunkSize, file.size)
    const data = await readChunk(file, range.offset, range.offset + range.length)
    if (data.byteLength !== range.length) {
      throw new Error(`VALIDATION: 读取分片 ${index} 长度不符（期望 ${range.length}，实际 ${data.byteLength}）`)
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted === true) throw cancelledError()
      try {
        await callJson<unknown>(
          fetchFn,
          `${UPLOAD_BASE}/chunk?uploadId=${encodeURIComponent(status!.uploadId)}&chunkIndex=${index}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: data,
            ...(signal !== undefined ? { signal } : {}),
          },
          `上传分片 ${index}`,
        )
        return
      } catch (error) {
        if (isAbortError(error, signal) || !isRetryable(error) || attempt >= maxRetries) throw error
        await sleep(25 * (attempt + 1))
      }
    }
  }

  // 4. 有限并发发送剩余分片
  const queue = [...missing]
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = queue.shift()
      if (index === undefined) return
      await sendChunk(index)
      transferred += chunkRange(index, chunkSize, file.size).length
      options.onProgress?.(transferred, file.size)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  } catch (error) {
    if (isAbortError(error, signal)) throw cancelledError()
    throw error
  }

  // 5. 收尾落位
  await callJson<{ ok: boolean; bytes: number; remotePath: string }>(
    fetchFn,
    `${UPLOAD_BASE}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: status.uploadId }),
      ...(signal !== undefined ? { signal } : {}),
    },
    '完成上传',
  )
  resume.delete(key)
  options.onProgress?.(file.size, file.size)
  return { uploadId: status.uploadId, bytes: file.size, remotePath }
}

/** 取消服务端上传会话（幂等），并清掉本地续传记录。 */
export async function cancelChunkedUpload(
  uploadId: string,
  options: { fetch?: FetchLike; signal?: AbortSignal; resume?: ResumeStore; resumeKey?: string } = {},
): Promise<{ ok: true }> {
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (fetchFn === undefined) throw new Error('NETWORK: 当前环境不支持 fetch')
  const result = await callJson<{ ok: true }>(
    fetchFn,
    `${UPLOAD_BASE}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    '取消上传',
  )
  if (options.resumeKey !== undefined) (options.resume ?? defaultResumeStore).delete(options.resumeKey)
  return result
}

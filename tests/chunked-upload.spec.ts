/**
 * 浏览器分片上传：分片切分、并发/进度、断点续传、重试、取消。
 * fetch / readChunk / resume store 全部注入，不跑真实网络。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  CHUNK_SIZE_BYTES,
  cancelChunkedUpload,
  chunkRange,
  isChunkedUploadEligible,
  missingChunkIndexes,
  resumeKey,
  uploadLargeFile,
  type ChunkSource,
  type FetchLike,
  type ResumeStore,
} from '../client/files/chunkedUpload.ts'

const encoder = new TextEncoder()

function fileOf(text: string): ChunkSource {
  const data = encoder.encode(text)
  return {
    size: data.length,
    slice(start, end) {
      const part = data.slice(start, end)
      return {
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      }
    },
  }
}

interface Call {
  url: string
  method: string
  body?: unknown
}

function memoryResume(): ResumeStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>()
  return {
    get: key => map.get(key),
    set: (key, value) => { map.set(key, value) },
    delete: key => { map.delete(key) },
    dump: () => map,
  }
}

function bodyJson(body: unknown): Record<string, unknown> {
  return typeof body === 'string' ? JSON.parse(body) as Record<string, unknown> : {}
}

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  return ''
}

interface ServerOptions {
  uploadId?: string
  chunkSize?: number
  status?: unknown
  statusStatus?: number
  /** chunk 回调：'network' = 抛网络错；'validation' = 400 VALIDATION；'fail-once' 由外部控制 */
  onChunk?: (index: number, attempt: number) => 'network' | 'validation' | undefined
  completeStatus?: number
  completeError?: boolean
}

function makeServer(options: ServerOptions = {}) {
  const calls: Call[] = []
  const chunkAttempts = new Map<number, number>()
  const uploadId = options.uploadId ?? 'up-new'
  const chunkSize = options.chunkSize ?? CHUNK_SIZE_BYTES
  const fetchFn = (async (url: string, init: { method?: string; body?: unknown } = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', body: init.body }
    calls.push(call)
    const path = url.split('?')[0]!
    const query = new URL(url, 'http://test.local').searchParams
    if (path.endsWith('/status')) {
      const status = options.statusStatus ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => status >= 200 && status < 300
          ? { ok: true, value: options.status }
          : { ok: false, error: { code: 'NOT_FOUND', message: '上传会话不存在' } },
      }
    }
    if (path.endsWith('/create')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: { uploadId, tempPath: `/tmp/.dsh-tmp-${uploadId}-x`, chunkSize, totalChunks: Math.ceil(10 / chunkSize) },
        }),
      }
    }
    if (path.endsWith('/chunk')) {
      const index = Number(query.get('chunkIndex'))
      const attempt = (chunkAttempts.get(index) ?? 0) + 1
      chunkAttempts.set(index, attempt)
      const behavior = options.onChunk?.(index, attempt)
      if (behavior === 'network') throw new Error('socket hang up')
      if (behavior === 'validation') {
        return { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'VALIDATION', message: '分片大小不符' } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { uploadId, chunkIndex: index, bytes: 4 } }) }
    }
    if (path.endsWith('/complete')) {
      if (options.completeError === true) {
        return { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'VALIDATION', message: '分片不完整' } }) }
      }
      return { ok: true, status: options.completeStatus ?? 200, json: async () => ({ ok: true, value: { ok: true, bytes: 10, remotePath: '/a.bin' } }) }
    }
    if (path.endsWith('/cancel')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { ok: true } }) }
    }
    throw new Error(`unexpected ${url}`)
  }) as unknown as FetchLike
  const chunksSent = (): Array<{ index: number; body: string }> => calls
    .filter(call => call.url.includes('/chunk?'))
    .map((call) => {
      const index = Number(new URL(call.url, 'http://test.local').searchParams.get('chunkIndex'))
      return { index, body: bodyText(call.body) }
    })
    .sort((a, b) => a.index - b.index)
  return { fetchFn, calls, chunksSent, uploadId }
}

describe('纯函数', () => {
  it('阈值 / 分片区间 / 缺失分片 / 续传键', () => {
    expect(CHUNKED_UPLOAD_THRESHOLD_BYTES).toBe(100 * 1024 * 1024)
    expect(CHUNK_SIZE_BYTES).toBe(4 * 1024 * 1024)
    expect(isChunkedUploadEligible(99 * 1024 * 1024)).toBe(false)
    expect(isChunkedUploadEligible(100 * 1024 * 1024)).toBe(true)
    expect(isChunkedUploadEligible(Number.NaN)).toBe(false)
    expect(chunkRange(0, 4, 10)).toEqual({ offset: 0, length: 4 })
    expect(chunkRange(2, 4, 10)).toEqual({ offset: 8, length: 2 })
    expect(chunkRange(3, 4, 10)).toEqual({ offset: 12, length: 0 })
    expect(missingChunkIndexes([], 3)).toEqual([0, 1, 2])
    expect(missingChunkIndexes([2, 0], 3)).toEqual([1])
    expect(missingChunkIndexes([0, 1, 2], 3)).toEqual([])
    expect(resumeKey('s1', '/a.bin', 10)).toBe('s1|/a.bin|10')
  })
})

describe('uploadLargeFile', () => {
  it('新建会话 → 分片并发上传 → complete；进度 0→total，续传记录清掉', async () => {
    const server = makeServer({ chunkSize: 4 })
    const resume = memoryResume()
    const progress: Array<[number, number]> = []
    const result = await uploadLargeFile({
      sessionId: 's1',
      remotePath: '/a.bin',
      file: fileOf('abcdefghij'),
      fetch: server.fetchFn,
      chunkSize: 4,
      concurrency: 2,
      resume,
      onProgress: (transferred, total) => progress.push([transferred, total]),
    })

    expect(result).toEqual({ uploadId: 'up-new', bytes: 10, remotePath: '/a.bin' })
    expect(server.calls[0]!.url).toContain('/create')
    expect(bodyJson(server.calls[0]!.body)).toMatchObject({ sessionId: 's1', remotePath: '/a.bin', totalBytes: 10, chunkSize: 4 })
    expect(server.chunksSent()).toEqual([
      { index: 0, body: 'abcd' },
      { index: 1, body: 'efgh' },
      { index: 2, body: 'ij' },
    ])
    expect(server.calls.at(-1)!.url).toContain('/complete')
    expect(bodyJson(server.calls.at(-1)!.body)).toEqual({ uploadId: 'up-new' })
    expect(progress[0]).toEqual([0, 10])
    expect(progress.at(-1)).toEqual([10, 10])
    const values = progress.map(p => p[0])
    expect([...values].sort((a, b) => a - b)).toEqual(values)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
    expect(resume.dump().size).toBe(0)
  })

  it('已有 uploadId → status 续传，只发缺失分片', async () => {
    const server = makeServer({
      status: {
        uploadId: 'up-old', remotePath: '/a.bin', totalBytes: 10, chunkSize: 4,
        totalChunks: 3, receivedOffsets: [0, 2], createdAtMs: 1, expiresAtMs: 2,
      },
    })
    const resume = memoryResume()
    resume.set(resumeKey('s1', '/a.bin', 10), 'up-old')
    const progress: number[] = []
    const result = await uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, resume, concurrency: 1,
      onProgress: transferred => progress.push(transferred),
    })
    expect(result.uploadId).toBe('up-old')
    expect(server.calls.some(call => call.url.includes('/create'))).toBe(false)
    expect(server.chunksSent()).toEqual([{ index: 1, body: 'efgh' }])
    expect(progress[0]).toBe(6)
    expect(progress.at(-1)).toBe(10)
  })

  it('status 失效（404）→ 重新 create 并重发全部分片', async () => {
    const server = makeServer({ statusStatus: 404, chunkSize: 4 })
    const resume = memoryResume()
    resume.set(resumeKey('s1', '/a.bin', 10), 'up-gone')
    const result = await uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, resume, chunkSize: 4,
    })
    expect(result.uploadId).toBe('up-new')
    expect(server.calls.filter(call => call.url.includes('/status'))).toHaveLength(1)
    expect(server.calls.filter(call => call.url.includes('/create'))).toHaveLength(1)
    expect(server.chunksSent().map(c => c.index)).toEqual([0, 1, 2])
    expect(resume.get(resumeKey('s1', '/a.bin', 10))).toBeUndefined()
  })

  it('status 的 remotePath / 大小不匹配 → 重新 create（不复用旧会话）', async () => {
    const server = makeServer({
      chunkSize: 4,
      status: {
        uploadId: 'up-old', remotePath: '/other.bin', totalBytes: 10, chunkSize: 4,
        totalChunks: 3, receivedOffsets: [0], createdAtMs: 1, expiresAtMs: 2,
      },
    })
    const resume = memoryResume()
    resume.set(resumeKey('s1', '/a.bin', 10), 'up-old')
    const result = await uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, resume, chunkSize: 4,
    })
    expect(result.uploadId).toBe('up-new')
    expect(server.chunksSent().map(c => c.index)).toEqual([0, 1, 2])
  })

  it('网络错误按有限次数重试（默认重试后成功）', async () => {
    const server = makeServer({
      chunkSize: 4,
      onChunk: (index, attempt) => (index === 0 && attempt === 1 ? 'network' : undefined),
    })
    const result = await uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, chunkSize: 4, maxRetries: 1, concurrency: 1,
    })
    expect(result.bytes).toBe(10)
    expect(server.chunksSent().filter(c => c.index === 0)).toHaveLength(2)
  })

  it('业务错误不重试；失败保留续传记录', async () => {
    const server = makeServer({
      chunkSize: 4,
      onChunk: index => (index === 1 ? 'validation' : undefined),
    })
    const resume = memoryResume()
    await expect(uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, chunkSize: 4, resume, maxRetries: 2, concurrency: 1,
    })).rejects.toThrow(/VALIDATION: 分片大小不符/)
    expect(server.chunksSent().filter(c => c.index === 1)).toHaveLength(1)
    expect(resume.get(resumeKey('s1', '/a.bin', 10))).toBe('up-new')
  })

  it('complete 失败：抛错且保留续传记录（下次可再 complete / 续传）', async () => {
    const server = makeServer({ chunkSize: 4, completeError: true })
    const resume = memoryResume()
    await expect(uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, chunkSize: 4, resume,
    })).rejects.toThrow(/VALIDATION: 分片不完整/)
    expect(resume.get(resumeKey('s1', '/a.bin', 10))).toBe('up-new')
  })

  it('取消信号：已 abort → CANCELLED，且不发请求', async () => {
    const server = makeServer()
    const controller = new AbortController()
    controller.abort()
    await expect(uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, signal: controller.signal, chunkSize: 4,
    })).rejects.toThrow(/CANCELLED/)
    expect(server.calls).toHaveLength(0)
  })

  it('readChunk 注入 + 长度校验失败 → VALIDATION（不发送坏分片）', async () => {
    const server = makeServer({ chunkSize: 4 })
    const readChunk = vi.fn(async () => encoder.encode('short'))
    await expect(uploadLargeFile({
      sessionId: 's1', remotePath: '/a.bin', file: fileOf('abcdefghij'),
      fetch: server.fetchFn, chunkSize: 4, readChunk, concurrency: 1,
    })).rejects.toThrow(/VALIDATION: 读取分片 0 长度不符/)
    expect(server.chunksSent()).toHaveLength(0)
    expect(readChunk).toHaveBeenCalledWith(expect.anything(), 0, 4)
  })

  it('参数校验：缺 sessionId / 相对 remotePath / 非法大小', async () => {
    const server = makeServer()
    await expect(uploadLargeFile({ sessionId: '', remotePath: '/a', file: fileOf('a'), fetch: server.fetchFn }))
      .rejects.toThrow(/VALIDATION/)
    await expect(uploadLargeFile({ sessionId: 's1', remotePath: 'a.bin', file: fileOf('a'), fetch: server.fetchFn }))
      .rejects.toThrow(/VALIDATION/)
    await expect(uploadLargeFile({ sessionId: 's1', remotePath: '/a', file: { size: 0, slice: fileOf('').slice }, fetch: server.fetchFn }))
      .rejects.toThrow(/VALIDATION/)
  })
})

describe('cancelChunkedUpload', () => {
  it('POST cancel 并清掉续传键', async () => {
    const server = makeServer()
    const resume = memoryResume()
    const key = resumeKey('s1', '/a.bin', 10)
    resume.set(key, 'up-old')
    await expect(cancelChunkedUpload('up-old', { fetch: server.fetchFn, resume, resumeKey: key })).resolves.toEqual({ ok: true })
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]!.url).toContain('/cancel')
    expect(bodyJson(server.calls[0]!.body)).toEqual({ uploadId: 'up-old' })
    expect(resume.get(key)).toBeUndefined()
  })
})

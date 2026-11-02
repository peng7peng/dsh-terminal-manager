/**
 * 分片上传的 5 条精确 Fetch 路由：路径 / 方法 / requestBody、请求解析、响应与错误。
 * 直接调 handler（认证由 Connection 负责，这里不重复造栅栏）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  createChunkedCancelFetch,
  createChunkedChunkFetch,
  createChunkedCompleteFetch,
  createChunkedCreateFetch,
  createChunkedStatusFetch,
  registerRemotes,
  type RemoteDeps,
} from '../src/remotes.ts'
import { FileServiceError } from '../src/file-errors.ts'
import { UploadError, type UploadSessionManager } from '../src/upload-protocol.ts'

interface FakeUploads {
  create: ReturnType<typeof vi.fn>
  writeChunk: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function fakeUploads(): FakeUploads {
  return {
    create: vi.fn(async (input: unknown) => ({
      uploadId: 'up-1',
      tempPath: '/dir/.dsh-tmp-up-1-a.bin',
      chunkSize: 4,
      totalChunks: 3,
      input,
    })),
    writeChunk: vi.fn(async (uploadId: string, chunkIndex: number, bytes: Buffer) => ({
      uploadId, chunkIndex, bytes: bytes.length,
    })),
    complete: vi.fn(async (uploadId: string) => ({ ok: true, bytes: 10, remotePath: `/done-${uploadId}` })),
    status: vi.fn(async (uploadId: string) => ({
      uploadId, remotePath: '/a.bin', totalBytes: 10, chunkSize: 4, totalChunks: 3,
      receivedOffsets: [0], createdAtMs: 1, expiresAtMs: 2,
    })),
    cancel: vi.fn(async () => ({ ok: true })),
  }
}

function depsWith(uploads?: unknown): RemoteDeps {
  return {
    sessions: {} as never,
    store: {} as never,
    ...(uploads !== undefined ? { uploads: uploads as UploadSessionManager } : {}),
  }
}

function post(url: string, body?: BodyInit | Record<string, unknown>): Request {
  if (body !== undefined && typeof body === 'object' && !(body instanceof Uint8Array) && !ArrayBuffer.isView(body) && typeof (body as Blob).arrayBuffer !== 'function') {
    return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  return new Request(url, { method: 'POST', ...(body !== undefined ? { body: body as BodyInit } : {}) })
}

describe('分片上传路由注册', () => {
  it('注册 5 条 /api 精确路由（方法 / requestBody 正确）', () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = {
      get: (name: string) => name === 'connection'
        ? { fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return async () => undefined } } }
        : undefined,
      effect: (fn: () => unknown) => fn(),
    } as unknown as Context
    registerRemotes(ctx, depsWith(fakeUploads()))
    const byPath = new Map(routes.map(route => [route.path, route]))
    expect(byPath.get('/api/term-manager/files/upload/chunked/create')).toMatchObject({ methods: ['POST'], requestBody: 'buffered' })
    expect(byPath.get('/api/term-manager/files/upload/chunked/chunk')).toMatchObject({ methods: ['POST'], requestBody: 'streaming' })
    expect(byPath.get('/api/term-manager/files/upload/chunked/complete')).toMatchObject({ methods: ['POST'], requestBody: 'buffered' })
    expect(byPath.get('/api/term-manager/files/upload/chunked/status')).toMatchObject({ methods: ['GET'], requestBody: 'buffered' })
    expect(byPath.get('/api/term-manager/files/upload/chunked/cancel')).toMatchObject({ methods: ['POST'], requestBody: 'buffered' })
  })
})

describe('POST /upload/chunked/create', () => {
  it('解析 JSON 并返回 create 结果', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedCreateFetch(depsWith(uploads))
    const response = await handler(post('http://localhost/api/term-manager/files/upload/chunked/create', {
      sessionId: 's1', remotePath: '/dir/a.bin', totalBytes: 10, chunkSize: 4,
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      value: { uploadId: 'up-1', chunkSize: 4, totalChunks: 3 },
    })
    expect(uploads.create).toHaveBeenCalledWith({ sessionId: 's1', remotePath: '/dir/a.bin', totalBytes: 10, chunkSize: 4 })
  })

  it('非法 JSON / 非对象 → 400 VALIDATION', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedCreateFetch(depsWith(uploads))
    const badJson = await handler(new Request('http://localhost/api/term-manager/files/upload/chunked/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }))
    expect(badJson.status).toBe(400)
    expect((await badJson.json() as { error: { message: string } }).error.message).toContain('VALIDATION')
    const arrayBody = await handler(post('http://localhost/api/term-manager/files/upload/chunked/create', '[1,2]' as never))
    expect(arrayBody.status).toBe(400)
    expect(uploads.create).not.toHaveBeenCalled()
  })

  it('业务错误（TOO_MANY_UPLOADS）→ 400，消息带错误码', async () => {
    const uploads = fakeUploads()
    uploads.create.mockRejectedValueOnce(new UploadError('TOO_MANY_UPLOADS', '活动上传已达上限（3）'))
    const response = await createChunkedCreateFetch(depsWith(uploads))(
      post('http://localhost/api/term-manager/files/upload/chunked/create', { sessionId: 's1', remotePath: '/a', totalBytes: 1 }),
    )
    expect(response.status).toBe(400)
    const body = await response.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('TOO_MANY_UPLOADS')
  })
})

describe('POST /upload/chunked/chunk', () => {
  it('raw body 原样交给 writeChunk（二进制不被字符串化）', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedChunkFetch(depsWith(uploads))
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f])
    const response = await handler(new Request(
      'http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=up-1&chunkIndex=2',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload },
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { uploadId: 'up-1', chunkIndex: 2, bytes: 4 } })
    const [uploadId, chunkIndex, bytes] = uploads.writeChunk.mock.calls[0]!
    expect(uploadId).toBe('up-1')
    expect(chunkIndex).toBe(2)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect((bytes as Buffer).equals(payload)).toBe(true)
  })

  it('缺 uploadId / 非法 chunkIndex → 400 VALIDATION；不调用 writeChunk', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedChunkFetch(depsWith(uploads))
    const cases = [
      'http://localhost/api/term-manager/files/upload/chunked/chunk?chunkIndex=0',
      'http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=up-1',
      'http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=up-1&chunkIndex=-1',
      'http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=up-1&chunkIndex=abc',
    ]
    for (const url of cases) {
      const response = await handler(new Request(url, { method: 'POST', body: Buffer.from('x') }))
      expect(response.status).toBe(400)
      expect((await response.json() as { error: { message: string } }).error.message).toContain('VALIDATION')
    }
    expect(uploads.writeChunk).not.toHaveBeenCalled()
  })

  it('空 body → 400 VALIDATION', async () => {
    const uploads = fakeUploads()
    const response = await createChunkedChunkFetch(depsWith(uploads))(
      new Request('http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=up-1&chunkIndex=0', { method: 'POST' }),
    )
    expect(response.status).toBe(400)
    expect(uploads.writeChunk).not.toHaveBeenCalled()
  })

  it('writeChunk 抛 NOT_FOUND → 404', async () => {
    const uploads = fakeUploads()
    uploads.writeChunk.mockRejectedValueOnce(new FileServiceError('NOT_FOUND', '上传会话不存在'))
    const response = await createChunkedChunkFetch(depsWith(uploads))(
      new Request('http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=nope&chunkIndex=0', {
        method: 'POST', body: Buffer.from('x'),
      }),
    )
    expect(response.status).toBe(404)
  })
})

describe('complete / status / cancel', () => {
  it('complete：JSON uploadId → {ok,bytes,remotePath}', async () => {
    const uploads = fakeUploads()
    const response = await createChunkedCompleteFetch(depsWith(uploads))(
      post('http://localhost/api/term-manager/files/upload/chunked/complete', { uploadId: 'up-1' }),
    )
    expect(await response.json()).toMatchObject({ ok: true, value: { ok: true, bytes: 10, remotePath: '/done-up-1' } })
    expect(uploads.complete).toHaveBeenCalledWith('up-1')
  })

  it('complete 缺 uploadId → 400 VALIDATION', async () => {
    const uploads = fakeUploads()
    const response = await createChunkedCompleteFetch(depsWith(uploads))(
      post('http://localhost/api/term-manager/files/upload/chunked/complete', {}),
    )
    expect(response.status).toBe(400)
    expect(uploads.complete).not.toHaveBeenCalled()
  })

  it('status：GET query → 状态；缺 uploadId → 400；NOT_FOUND → 404', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedStatusFetch(depsWith(uploads))
    const ok = await handler(new Request('http://localhost/api/term-manager/files/upload/chunked/status?uploadId=up-1'))
    expect(await ok.json()).toMatchObject({ ok: true, value: { uploadId: 'up-1', receivedOffsets: [0] } })

    const missing = await handler(new Request('http://localhost/api/term-manager/files/upload/chunked/status'))
    expect(missing.status).toBe(400)

    uploads.status.mockRejectedValueOnce(new FileServiceError('NOT_FOUND', '上传会话不存在'))
    const gone = await handler(new Request('http://localhost/api/term-manager/files/upload/chunked/status?uploadId=nope'))
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ ok: false })
  })

  it('cancel：JSON uploadId → {ok:true}；缺 uploadId → 400', async () => {
    const uploads = fakeUploads()
    const handler = createChunkedCancelFetch(depsWith(uploads))
    const response = await handler(post('http://localhost/api/term-manager/files/upload/chunked/cancel', { uploadId: 'up-1' }))
    expect(await response.json()).toMatchObject({ ok: true, value: { ok: true } })
    expect(uploads.cancel).toHaveBeenCalledWith('up-1')
    const missing = await handler(post('http://localhost/api/term-manager/files/upload/chunked/cancel', {}))
    expect(missing.status).toBe(400)
  })
})

describe('未装配 UploadSessionManager', () => {
  it('5 条路由都返回 400 UNSUPPORTED', async () => {
    const handlers = [
      { fetch: createChunkedCreateFetch(depsWith()), request: post('http://localhost/api/term-manager/files/upload/chunked/create', {}) },
      { fetch: createChunkedChunkFetch(depsWith()), request: new Request('http://localhost/api/term-manager/files/upload/chunked/chunk?uploadId=x&chunkIndex=0', { method: 'POST', body: Buffer.from('x') }) },
      { fetch: createChunkedCompleteFetch(depsWith()), request: post('http://localhost/api/term-manager/files/upload/chunked/complete', { uploadId: 'x' }) },
      { fetch: createChunkedStatusFetch(depsWith()), request: new Request('http://localhost/api/term-manager/files/upload/chunked/status?uploadId=x') },
      { fetch: createChunkedCancelFetch(depsWith()), request: post('http://localhost/api/term-manager/files/upload/chunked/cancel', { uploadId: 'x' }) },
    ]
    for (const handler of handlers) {
      const response = await handler.fetch(handler.request)
      expect(response.status).toBe(400)
      expect((await response.json() as { error: { message: string } }).error.message).toContain('UNSUPPORTED')
    }
  })
})

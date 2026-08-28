import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rpc, type RpcError } from '../client/rpc.ts'

describe('client/rpc.ts', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let randomUUIDSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 固定 rpcId 以便断言
    randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-rpc-id-123' as `${string}-${string}-${string}-${string}-${string}`)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    randomUUIDSpy.mockRestore()
  })

  it('正常调用 → 返回 result.value', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { ok: true, value: { data: 'hello' } },
      }),
    })

    const result = await rpc<{ data: string }>('test.method', { foo: 'bar' })
    expect(result).toEqual({ data: 'hello' })
  })

  it('后端返回 ok:false → 抛 RpcError，error.code 正确', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          ok: false,
          error: { code: 'VALIDATION', message: '参数不合法' },
        },
      }),
    })

    try {
      await rpc('test.method', {})
      expect.fail('应该抛出错误')
    } catch (error) {
      const rpcError = error as RpcError
      expect(rpcError).toBeInstanceOf(Error)
      expect(rpcError.code).toBe('VALIDATION')
      expect(rpcError.message).toContain('VALIDATION')
      expect(rpcError.message).toContain('参数不合法')
    }
  })

  it('fetch 返回 HTTP 错误 → 抛 RpcError，code 含 HTTP_ 前缀', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })

    try {
      await rpc('test.method', {})
      expect.fail('应该抛出错误')
    } catch (error) {
      const rpcError = error as RpcError
      expect(rpcError).toBeInstanceOf(Error)
      expect(rpcError.code).toBe('HTTP_500')
      expect(rpcError.message).toContain('HTTP_500')
    }
  })

  it('fetch 返回 404 → 抛 RpcError，code 为 HTTP_404', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    try {
      await rpc('nonexistent', {})
      expect.fail('应该抛出错误')
    } catch (error) {
      const rpcError = error as RpcError
      expect(rpcError.code).toBe('HTTP_404')
    }
  })

  it('调用时 fetch 的参数正确', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { ok: true, value: null },
      }),
    })

    await rpc('sessions.list', { filter: 'active' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]

    // URL 正确
    expect(url).toBe('/term-manager/sessions.list')

    // method 正确
    expect(options.method).toBe('POST')

    // headers 正确
    expect(options.headers).toEqual({ 'content-type': 'application/json' })

    // body 正确
    const body = JSON.parse(options.body)
    expect(body.type).toBe('client-request')
    expect(body.rpcId).toBe('test-rpc-id-123')
    expect(body.method).toBe('sessions.list')
    expect(body.payload).toEqual({ filter: 'active' })
  })

  it('payload 为空时默认为空对象', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { ok: true, value: null },
      }),
    })

    await rpc('test.method')

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.payload).toEqual({})
  })

  it('返回值为基本类型（string）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { ok: true, value: 'hello world' },
      }),
    })

    const result = await rpc<string>('test.method')
    expect(result).toBe('hello world')
  })

  it('返回值为数组', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { ok: true, value: [1, 2, 3] },
      }),
    })

    const result = await rpc<number[]>('test.method')
    expect(result).toEqual([1, 2, 3])
  })
})

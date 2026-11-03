/**
 * remoteFs 与分片上传的集成：≥100 MiB 走 chunkedUpload，小文件仍走 HTTP 直传；
 * 进度 / 取消 / 冲突续传都不破坏既有传输行。
 */
import { describe, expect, it, vi } from 'vitest'
import { CHUNKED_UPLOAD_THRESHOLD_BYTES } from '../client/files/chunkedUpload.ts'
import {
  createRemoteFsStore,
  type ChunkedUploadFn,
  type HttpUpload,
  type RemoteFsDeps,
  type RpcFn,
} from '../client/files/remoteFs.ts'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function uuidSeq(): () => string {
  let n = 0
  return () => `t${++n}`
}

function rpcFake(entries: Array<{ name: string; path: string; kind: string }> = []): RpcFn {
  return (async <T,>(method: string): Promise<T> => {
    if (method === 'files.remoteTree') return entries as T
    return {} as T
  }) as unknown as RpcFn
}

function makeStore(overrides: Partial<RemoteFsDeps> = {}): ReturnType<typeof createRemoteFsStore> {
  const deps: RemoteFsDeps = {
    rpc: rpcFake(),
    uuid: uuidSeq(),
    ...overrides,
  }
  return createRemoteFsStore(deps)
}

const bigFile = (name = 'big.bin'): File => ({ name, size: CHUNKED_UPLOAD_THRESHOLD_BYTES } as File)

describe('uploadBrowserFile 分片阈值', () => {
  it('小文件仍走 HTTP 直传，不触发分片实现', async () => {
    const httpUpload = vi.fn<HttpUpload>(async () => {})
    const chunkedUpload = vi.fn<ChunkedUploadFn>(async args => ({ bytes: args.file.size }))
    const store = makeStore({ httpUpload, chunkedUpload })
    await store.setSession('s1')

    expect(store.uploadBrowserFile({ name: 'small.txt', size: 9 } as File)).toBe('started')
    await tick()
    expect(httpUpload).toHaveBeenCalledTimes(1)
    expect(httpUpload.mock.calls[0]![0].url).toContain('/files/upload?')
    expect(chunkedUpload).not.toHaveBeenCalled()
    expect(store.getState().transfers[0]).toMatchObject({ name: 'small.txt', done: true, ok: true })
  })

  it('≥100 MiB 走 chunkedUpload：远端路径、进度、完成行', async () => {
    const chunkedUpload = vi.fn<ChunkedUploadFn>(async args => ({ bytes: args.file.size, uploadId: 'u1' }))
    const store = makeStore({ chunkedUpload })
    await store.setSession('s1')

    expect(store.uploadBrowserFile(bigFile())).toBe('started')
    expect(chunkedUpload).toHaveBeenCalledTimes(1)
    const args = chunkedUpload.mock.calls[0]![0]
    expect(args).toMatchObject({ sessionId: 's1', remotePath: '/big.bin', file: { name: 'big.bin' } })
    expect(args.signal).toBeInstanceOf(AbortSignal)

    args.onProgress(50, 100)
    expect(store.getState().transfers[0]).toMatchObject({ transferred: 50, percent: 50, done: false })

    await tick()
    expect(store.getState().transfers[0]).toMatchObject({
      transferId: 't1', op: 'upload', remotePath: '/big.bin',
      done: true, ok: true, transferred: CHUNKED_UPLOAD_THRESHOLD_BYTES,
    })
  })

  it('同名冲突 → 决策后才走分片上传（覆盖最终名）', async () => {
    const chunkedUpload = vi.fn<ChunkedUploadFn>(async args => ({ bytes: args.file.size }))
    const store = makeStore({
      rpc: rpcFake([{ name: 'big.bin', path: '/big.bin', kind: 'file' }]),
      chunkedUpload,
    })
    await store.setSession('s1')
    expect(store.uploadBrowserFile(bigFile())).toBe('conflict')
    expect(chunkedUpload).not.toHaveBeenCalled()
    store.resolveConflict('overwrite')
    expect(chunkedUpload).toHaveBeenCalledTimes(1)
    expect(chunkedUpload.mock.calls[0]![0].remotePath).toBe('/big.bin')
    await tick()
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: true })
  })

  it('分片上传失败 → 行显示错误（humanError 去掉错误码前缀）', async () => {
    const chunkedUpload = vi.fn<ChunkedUploadFn>(async () => {
      throw new Error('NETWORK: 上传分片 2请求失败')
    })
    const store = makeStore({ chunkedUpload })
    await store.setSession('s1')
    store.uploadBrowserFile(bigFile())
    await tick()
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: false, error: '上传分片 2请求失败' })
  })

  it('cancelTransfer 中止信号 → 行标记失败「上传已取消」；未知 id 不抛', async () => {
    const chunkedUpload = vi.fn<ChunkedUploadFn>(args => new Promise((_resolve, reject) => {
      args.signal?.addEventListener('abort', () => reject(new Error('CANCELLED: 上传已取消')))
    }))
    const store = makeStore({ chunkedUpload })
    await store.setSession('s1')
    store.uploadBrowserFile(bigFile())
    expect(() => store.cancelTransfer('nope')).not.toThrow()
    store.cancelTransfer('t1')
    await tick()
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: false, error: '上传已取消' })
  })
})

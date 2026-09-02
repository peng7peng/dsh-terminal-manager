/**
 * F7 本地文件面板逻辑：纯函数 + store（假 rpc / 假 storage）。
 */
import { describe, expect, it, vi } from 'vitest'
import { baseName, breadcrumbs, createLocalFsStore, formatSize, humanError, isSameOrInside, parentDir, type FileEntryView, type RpcFn } from '../client/files/localFs.ts'

describe('路径纯函数', () => {
  it('parentDir：Windows / POSIX，到顶返回自身', () => {
    expect(parentDir('D:\\work\\a\\b')).toBe('D:/work/a')
    expect(parentDir('D:/work')).toBe('D:/')
    expect(parentDir('D:/')).toBe('D:/')
    expect(parentDir('/home/u/x')).toBe('/home/u')
    expect(parentDir('/home')).toBe('/')
    expect(parentDir('/')).toBe('/')
  })
  it('isSameOrInside：Windows 大小写不敏感，前缀不能是半个目录名', () => {
    expect(isSameOrInside('D:\\Work', 'd:/work/sub')).toBe(true)
    expect(isSameOrInside('D:/work', 'D:/work')).toBe(true)
    expect(isSameOrInside('D:/work', 'D:/workx')).toBe(false)
    expect(isSameOrInside('/r', '/R/x')).toBe(false)
  })
  it('breadcrumbs：根显示目录名，后续为相对段；根外只显示 cwd', () => {
    expect(breadcrumbs('D:\\work\\dut', 'D:\\work\\dut\\a\\b')).toEqual([
      { label: 'dut', path: 'D:/work/dut' }, { label: 'a', path: 'D:/work/dut/a' }, { label: 'b', path: 'D:/work/dut/a/b' },
    ])
    expect(breadcrumbs('D:/', 'D:/x')).toEqual([{ label: 'D:/', path: 'D:/' }, { label: 'x', path: 'D:/x' }])
    expect(breadcrumbs('/r', '/other')).toEqual([{ label: '/other', path: '/other' }])
  })
  it('baseName / formatSize / humanError', () => {
    expect(baseName('D:/a/b.txt')).toBe('b.txt')
    expect(baseName('/')).toBe('/')
    expect(formatSize(undefined)).toBe('')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(humanError(new Error('PATH_OUTSIDE_ROOT: 路径在当前文件树根之外'))).toBe('路径在当前文件树根之外')
    expect(humanError('x')).toBe('x')
  })
})

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, dump: () => Object.fromEntries(m) }
}

function fakeRpc(tree: Record<string, FileEntryView[]>, root = 'D:/ws') {
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const rpc = vi.fn(async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
    calls.push([method, payload])
    if (method === 'files.root') return { root } as T
    if (method === 'files.tree') {
      const p = String(payload?.path)
      if (!(p in tree)) throw new Error('NOT_FOUND: 目录不存在')
      return tree[p] as T
    }
    throw new Error(`unknown ${method}`)
  }) as unknown as RpcFn & { mock: { calls: unknown[][] } }
  return { rpc, calls }
}

const TREE: Record<string, FileEntryView[]> = {
  'D:/ws': [{ name: 'sub', path: 'D:/ws/sub', kind: 'dir' }, { name: 'a.txt', path: 'D:/ws/a.txt', kind: 'file', size: 10 }],
  'D:/ws/sub': [{ name: 'in.md', path: 'D:/ws/sub/in.md', kind: 'file', size: 3 }],
  'E:/other': [],
}

describe('localFs store', () => {
  it('init：无记忆时问后端树根并列根目录', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await store.init()
    const s = store.getState()
    expect(s.ready).toBe(true)
    expect(s.root).toBe('D:/ws')
    expect(s.cwd).toBe('D:/ws')
    expect(s.entries.map(e => e.name)).toEqual(['sub', 'a.txt'])
    expect(rpc.mock.calls.some(c => c[0] === 'files.root')).toBe(true)
  })

  it('init：localStorage 记住的树根优先，不问后端', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage({ 'tm.files.root': 'D:/ws/sub' }) })
    await store.init()
    expect(store.getState().root).toBe('D:/ws/sub')
    expect(rpc.mock.calls.some(c => c[0] === 'files.root')).toBe(false)
  })

  it('enter / up：只在树根内移动，到根后 up 不动；进入时清选中', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await store.init()
    store.select('D:/ws/a.txt')
    await store.enter('D:/ws/sub')
    expect(store.getState().cwd).toBe('D:/ws/sub')
    expect(store.getState().selected).toBeNull()
    expect(store.getState().entries.map(e => e.name)).toEqual(['in.md'])
    await store.enter('E:/other')          // 根外：忽略
    expect(store.getState().cwd).toBe('D:/ws/sub')
    await store.up()
    expect(store.getState().cwd).toBe('D:/ws')
    await store.up()
    expect(store.getState().cwd).toBe('D:/ws')
  })

  it('refresh 失败：错误信息去掉错误码前缀，列表清空', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await store.init()
    await store.setRoot('D:/gone')
    expect(store.getState().error).toBe('目录不存在')
    expect(store.getState().entries).toEqual([])
  })

  it('setRoot：换根并记忆；expanded 记忆', async () => {
    const storage = fakeStorage()
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage })
    await store.init()
    await store.setRoot('E:/other')
    expect(store.getState().root).toBe('E:/other')
    expect(store.getState().cwd).toBe('E:/other')
    expect(storage.dump()['tm.files.root']).toBe('E:/other')
    store.setExpanded(true)
    expect(storage.dump()['tm.files.expanded']).toBe('1')
    store.toggleExpanded()
    expect(store.getState().expanded).toBe(false)
  })

  it('并发加载：后发起的结果胜出', async () => {
    let resolveSlow: (v: FileEntryView[]) => void = () => {}
    const rpc = vi.fn(async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
      if (method === 'files.root') return { root: 'D:/ws' } as T
      if (payload?.path === 'D:/ws/slow') return new Promise<T>(r => { resolveSlow = r as (v: FileEntryView[]) => void })
      return TREE[String(payload?.path)] as T
    }) as unknown as RpcFn
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await store.init()
    const slow = store.enter('D:/ws/slow')
    await store.enter('D:/ws/sub')
    resolveSlow([{ name: 'late', path: 'D:/ws/slow/late', kind: 'file' }])
    await slow
    expect(store.getState().cwd).toBe('D:/ws/sub')
    expect(store.getState().entries.map(e => e.name)).toEqual(['in.md'])
  })
})

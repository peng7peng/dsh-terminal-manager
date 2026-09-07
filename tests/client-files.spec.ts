/**
 * F7 本地文件面板逻辑：纯函数 + store（假 rpc / 假 storage）。
 * S5：远端文件面板 remoteFs（纯函数 + store + 传输 / 冲突 / 进度帧）。
 */
import { describe, expect, it, vi } from 'vitest'
import { baseName, breadcrumbs, createLocalFsStore, formatSize, humanError, isSameOrInside, parentDir, type FileEntryView, type RpcFn } from '../client/files/localFs.ts'
import { createRemoteFsStore, localJoin, remoteJoin, remoteParent, renameCandidate } from '../client/files/remoteFs.ts'

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

  it('init：localStorage 记住的树根优先；后端仍会问一次（拿工作区目录）', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage({ 'tm.files.root': 'D:/ws/sub' }) })
    await store.init()
    expect(store.getState().root).toBe('D:/ws/sub')
    expect(rpc.mock.calls.some(c => c[0] === 'files.root')).toBe(true)
    expect(store.getState().workspaceRoot).toBe('D:/ws')
  })

  it('goWorkspace：回到工作区目录并记忆；后端不可用时置灰不动作', async () => {
    const { rpc } = fakeRpc(TREE)
    const storage = fakeStorage({ 'tm.files.root': 'E:/other' })
    const store = createLocalFsStore({ rpc, storage })
    await store.init()
    expect(store.getState().root).toBe('E:/other')
    await store.goWorkspace()
    expect(store.getState().root).toBe('D:/ws')
    expect(store.getState().cwd).toBe('D:/ws')
    expect(storage.dump()['tm.files.root']).toBe('D:/ws')
  })

  it('init：后端不可用且无记忆 → 报错；有记忆 → 正常打开，工作区未知（按钮禁用）', async () => {
    const rpc = vi.fn(async <T,>(method: string): Promise<T> => {
      if (method === 'files.root') throw new Error('HTTP_500: 后端挂了')
      throw new Error(`unknown ${method}`)
    }) as unknown as RpcFn
    const none = createLocalFsStore({ rpc, storage: fakeStorage() })
    await none.init()
    expect(none.getState().ready).toBe(false)
    expect(none.getState().error).toContain('无法获取根目录')
    await none.goWorkspace() // 不抛错、不动作
    expect(none.getState().root).toBe('')

    const memo = createLocalFsStore({ rpc, storage: fakeStorage({ 'tm.files.root': 'D:/ws' }) })
    await memo.init()
    expect(memo.getState().ready).toBe(true)
    expect(memo.getState().workspaceRoot).toBe('')
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

  it('进入一个进不去的目录：cwd 不变（面包屑不指向没进去的目录），只报错', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await store.init()
    await store.enter('D:/ws/missing')
    expect(store.getState().cwd).toBe('D:/ws')
    expect(store.getState().error).toBe('目录不存在')
  })

  it('init 并发调用只问一次后端', async () => {
    const { rpc } = fakeRpc(TREE)
    const store = createLocalFsStore({ rpc, storage: fakeStorage() })
    await Promise.all([store.init(), store.init(), store.init()])
    expect(rpc.mock.calls.filter(c => c[0] === 'files.root')).toHaveLength(1)
    expect(rpc.mock.calls.filter(c => c[0] === 'files.tree')).toHaveLength(1)
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

// ── S5 remoteFs ──

const REMOTE: Record<string, FileEntryView[]> = {
  '/': [{ name: 'etc', path: '/etc', kind: 'dir' }, { name: 'b.txt', path: '/b.txt', kind: 'file', size: 5 }],
  '/etc': [{ name: 'host.conf', path: '/etc/host.conf', kind: 'file', size: 2 }],
}

describe('remoteFs 纯函数（S5）', () => {
  it('remoteJoin / remoteParent / localJoin', () => {
    expect(remoteJoin('/', 'a.txt')).toBe('/a.txt')
    expect(remoteJoin('/var/log', 'a.txt')).toBe('/var/log/a.txt')
    expect(remoteParent('/var/log/a.txt')).toBe('/var/log')
    expect(remoteParent('/a.txt')).toBe('/')
    expect(remoteParent('/')).toBe('/')
    expect(localJoin('D:/ws/out', 'a.txt')).toBe('D:/ws/out/a.txt')
    expect(localJoin('D:/', 'a.txt')).toBe('D:/a.txt')
  })
  it('renameCandidate：资源管理器风格；.hidden 整体当名字', () => {
    expect(renameCandidate('a.txt', new Set(['a.txt']))).toBe('a (1).txt')
    expect(renameCandidate('a.txt', new Set(['a.txt', 'a (1).txt']))).toBe('a (2).txt')
    expect(renameCandidate('noext', new Set(['noext']))).toBe('noext (1)')
    expect(renameCandidate('.hidden', new Set(['.hidden']))).toBe('.hidden (1)')
  })
})

/** 远端假 rpc：files.remoteTree 按 REMOTE 应答，其余走 extra（未命中抛 unknown） */
function remoteRpcFake(extra?: (method: string, payload?: Record<string, unknown>) => unknown) {
  return vi.fn(async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
    if (method === 'files.remoteTree') {
      const list = REMOTE[String(payload?.path)]
      if (list === undefined) throw new Error('NOT_FOUND: 目录不存在')
      return list as T
    }
    const r = extra?.(method, payload)
    if (r !== undefined) return r as T
    throw new Error(`unknown ${method}`)
  }) as unknown as RpcFn & { mock: { calls: Array<[string, Record<string, unknown> | undefined]> } }
}

function uuidSeq(): () => string {
  let n = 0
  return () => `t${++n}`
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

describe('remoteFs store（S5）', () => {
  it('setSession 列根目录；enter / up；失败不改 cwd；每会话记忆目录', async () => {
    const store = createRemoteFsStore({ rpc: remoteRpcFake(), uuid: uuidSeq() })
    await store.setSession('s1')
    expect(store.getState()).toMatchObject({ sessionId: 's1', cwd: '/', loading: false })
    expect(store.getState().entries.map(e => e.name)).toEqual(['etc', 'b.txt'])
    await store.enter('/etc')
    expect(store.getState().cwd).toBe('/etc')
    expect(store.getState().selected).toBeNull()
    await store.enter('a.txt')                       // 相对路径忽略
    expect(store.getState().cwd).toBe('/etc')
    await store.enter('/missing')
    expect(store.getState().cwd).toBe('/etc')        // 进不去不改面包屑
    expect(store.getState().error).toBe('目录不存在')
    await store.setSession('s2')
    expect(store.getState().cwd).toBe('/')
    await store.setSession('s1')
    expect(store.getState().cwd).toBe('/etc')        // 每会话记忆
    await store.up()
    expect(store.getState().cwd).toBe('/')
    await store.up()
    expect(store.getState().cwd).toBe('/')           // 到顶不动
  })

  it('uploadLocalFile：无冲突直接传（payload 齐）；进度帧按 transferId 生效；成功刷新列表', async () => {
    const rpc = remoteRpcFake((method) => method === 'files.uploadLocal' ? { bytes: 42 } : undefined)
    const store = createRemoteFsStore({ rpc, uuid: uuidSeq() })
    await store.setSession('s1')
    const r = store.uploadLocalFile({ root: 'D:/ws', path: 'D:/ws/a.txt', name: 'a.txt', size: 42 })
    expect(r).toBe('started')
    const calls = rpc.mock.calls.filter(c => c[0] === 'files.uploadLocal')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ sessionId: 's1', remotePath: '/a.txt', root: 'D:/ws', path: 'D:/ws/a.txt', transferId: 't1' })
    expect(store.getState().transfers[0]).toMatchObject({ op: 'upload', name: 'a.txt', remotePath: '/a.txt', total: 42, done: false })
    store.pushFrame({ kind: 'file-progress', transferId: 't1', transferred: 21, total: 42 })
    expect(store.getState().transfers[0]).toMatchObject({ transferred: 21, percent: 50 })
    await tick()
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: true, transferred: 42 })
    // 还停在原目录 → 自动刷新（files.remoteTree 再问一次）
    expect(rpc.mock.calls.filter(c => c[0] === 'files.remoteTree').length).toBeGreaterThanOrEqual(2)
  })

  it('上传同名 → conflict；覆盖 / 跳过 / 重命名', async () => {
    const rpc = remoteRpcFake((method) => method === 'files.uploadLocal' ? { bytes: 3 } : undefined)
    const store = createRemoteFsStore({ rpc, uuid: uuidSeq() })
    await store.setSession('s1')                     // '/' 已有 b.txt
    expect(store.uploadLocalFile({ root: 'D:/ws', path: 'D:/ws/b.txt', name: 'b.txt' })).toBe('conflict')
    expect(store.getState().conflict).toEqual({ op: 'upload', name: 'b.txt' })
    expect(rpc.mock.calls.filter(c => c[0] === 'files.uploadLocal')).toHaveLength(0)
    store.resolveConflict('skip')
    expect(store.getState().conflict).toBeNull()
    expect(store.getState().transfers).toHaveLength(0)
    expect(store.uploadLocalFile({ root: 'D:/ws', path: 'D:/ws/b.txt', name: 'b.txt' })).toBe('conflict')
    store.resolveConflict('overwrite')
    expect(store.getState().transfers[0]).toMatchObject({ name: 'b.txt', remotePath: '/b.txt' })
    await tick()
    expect(store.uploadLocalFile({ root: 'D:/ws', path: 'D:/ws/b.txt', name: 'b.txt' })).toBe('conflict')
    store.resolveConflict('rename')
    expect(store.getState().transfers.at(-1)).toMatchObject({ name: 'b (1).txt', remotePath: '/b (1).txt' })
  })

  it('downloadToWorkspace：目标 = 本地当前目录 + 远端名；本地同名走冲突；blocked', async () => {
    const rpc = remoteRpcFake((method) => method === 'files.downloadToLocal' ? { bytes: 7 } : undefined)
    let refreshed = 0
    const store = createRemoteFsStore({
      rpc,
      uuid: uuidSeq(),
      localNames: () => new Set(['b.txt']),
      localTarget: () => ({ root: 'D:/ws', path: 'D:/ws/out' }),
      localRefresh: () => { refreshed += 1 },
    })
    expect(store.downloadToWorkspace('/var/log/c.txt')).toBe('blocked')   // 未选会话
    await store.setSession('s1')
    expect(store.downloadToWorkspace('/var/log/b.txt')).toBe('conflict')
    store.resolveConflict('rename')
    expect(store.getState().transfers.at(-1)).toMatchObject({ name: 'b (1).txt', remotePath: '/var/log/b.txt', localPath: 'D:/ws/out/b (1).txt' })
    await tick()
    expect(store.downloadToWorkspace('/var/log/c.txt')).toBe('started')
    const calls = rpc.mock.calls.filter(c => c[0] === 'files.downloadToLocal')
    expect(calls.at(-1)![1]).toMatchObject({ sessionId: 's1', remotePath: '/var/log/c.txt', root: 'D:/ws', path: 'D:/ws/out/c.txt' })
    await tick()
    expect(refreshed).toBe(2)                        // 两次下载成功 → 刷新两次
  })

  it('uploadBrowserFile：OS 拖拽 → HTTP 直传 URL 带 query；onprogress 生效', async () => {
    const uploads: Array<{ url: string; body: Blob }> = []
    let onProgress: (t: number, total?: number) => void = () => {}
    const httpUpload = vi.fn(async (args: { url: string; body: Blob; onProgress: (t: number, total?: number) => void }) => {
      uploads.push({ url: args.url, body: args.body })
      onProgress = args.onProgress
    })
    const store = createRemoteFsStore({ rpc: remoteRpcFake(), uuid: uuidSeq(), httpUpload })
    await store.setSession('s1')
    const file = { name: 'cfg.json', size: 9 } as File
    expect(store.uploadBrowserFile(file)).toBe('started')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.url).toBe('/term-manager/files/upload?sessionId=s1&remotePath=%2Fcfg.json&transferId=t1')
    onProgress(4, 9)
    expect(store.getState().transfers[0]).toMatchObject({ transferred: 4, percent: 44 })
    await tick()
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: true })
  })

  it('saveAs：导航式 GET（另存为）；别人的帧忽略；行靠终态帧收尾', async () => {
    const nav: string[] = []
    const store = createRemoteFsStore({ rpc: remoteRpcFake(), uuid: uuidSeq(), navigate: u => { nav.push(u) } })
    expect(store.saveAs('/var/log/app.log')).toBe('blocked')
    await store.setSession('s1')
    expect(store.saveAs('/var/log/app.log')).toBe('started')
    expect(nav).toEqual(['/term-manager/files/download?sessionId=s1&remotePath=%2Fvar%2Flog%2Fapp.log&transferId=t1'])
    expect(store.getState().transfers[0]).toMatchObject({ op: 'download', name: 'app.log', remotePath: '/var/log/app.log' })
    store.pushFrame({ kind: 'file-progress', transferId: 'other', transferred: 999, done: true, ok: true })   // 别人的
    expect(store.getState().transfers[0]).toMatchObject({ done: false })
    store.pushFrame({ kind: 'file-progress', transferId: 't1', transferred: 30, total: 100 })
    expect(store.getState().transfers[0]).toMatchObject({ percent: 30 })
    store.pushFrame({ kind: 'file-progress', transferId: 't1', done: true, ok: true, transferred: 100 })
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: true, transferred: 100 })
  })

  it('clearFinished 保留进行中并收缩 id 集；掉线 setSession(null) 保留传输行、终态帧仍能落到行上', async () => {
    const store = createRemoteFsStore({ rpc: remoteRpcFake(), uuid: uuidSeq() })
    await store.setSession('s1')
    store.saveAs('/b.txt')                                                    // t1
    store.pushFrame({ kind: 'file-progress', transferId: 't1', done: true, ok: true, transferred: 5 })
    store.saveAs('/etc/host.conf')                                            // t2 进行中
    store.pushFrame({ kind: 'file-progress', transferId: 't2', transferred: 1 })
    store.clearFinished()
    expect(store.getState().transfers.map(t => t.transferId)).toEqual(['t2'])
    // 掉线：只清界面状态，保留传输行（审查 M3：清掉会吞掉在途传输的终态反馈）
    await store.setSession(null)
    expect(store.getState()).toMatchObject({ sessionId: null, cwd: '/', entries: [] })
    expect(store.getState().transfers.map(t => t.transferId)).toEqual(['t2'])
    store.pushFrame({ kind: 'file-progress', transferId: 't2', done: true, ok: false, error: '传输被取消', transferred: 0 })
    expect(store.getState().transfers[0]).toMatchObject({ done: true, ok: false, error: '传输被取消', transferred: 1 }) // 审查 L4：失败帧不清零已传字节
    await store.refresh()                                                     // 无会话时 no-op 不抛
  })

  it('切会话使未决的冲突决策作废（审查 L2：pending 绑定旧会话/旧目录）', async () => {
    const rpc = remoteRpcFake((method) => method === 'files.uploadLocal' ? { bytes: 3 } : undefined)
    const store = createRemoteFsStore({ rpc, uuid: uuidSeq() })
    await store.setSession('s1')
    expect(store.uploadLocalFile({ root: 'D:/ws', path: 'D:/ws/b.txt', name: 'b.txt' })).toBe('conflict')
    await store.setSession('s2')
    expect(store.getState().conflict).toBeNull()
    store.resolveConflict('overwrite')
    expect(store.getState().transfers).toHaveLength(0)                        // 决策已作废，不会传到旧会话
  })
})

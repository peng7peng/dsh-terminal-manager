/**
 * F8 编辑器状态仓库：开 / 关 / 切换 / 脏标记 / 关前确认 / 窗口开合。
 */
import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, extOf, fileNameOf, type EditorRpc } from '../client/editor/editorStore.ts'

function fakeDeps(files: Record<string, string> = {}, opts: { failWrite?: boolean } = {}) {
  const writes: Array<{ path: string; content: string }> = []
  const info: string[] = []
  const errors: string[] = []
  const rpc = vi.fn(async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'files.read') {
      const p = String(payload?.path)
      if (!(p in files)) throw new Error('NOT_FOUND: 文件不存在')
      const content = files[p]!
      const max = Number(payload?.maxBytes ?? 1e9)
      return content.length > max
        ? { content: content.slice(0, max), size: content.length, truncated: true }
        : { content, size: content.length, truncated: false }
    }
    if (method === 'files.write') {
      if (opts.failWrite) throw new Error('REMOTE_IO: 磁盘满')
      writes.push({ path: String(payload?.path), content: String(payload?.content) })
      return { bytes: String(payload?.content).length }
    }
    throw new Error(`unknown ${method}`)
  }) as unknown as EditorRpc
  return { rpc, writes, info, errors, deps: { rpc, getRoot: () => 'D:/ws', onInfo: (m: string) => info.push(m), onError: (m: string) => errors.push(m) } }
}

describe('纯函数', () => {
  it('fileNameOf / extOf', () => {
    expect(fileNameOf('D:\\ws\\a\\case1.txt')).toBe('case1.txt')
    expect(fileNameOf('/x/y/README')).toBe('README')
    expect(extOf('a/b.TXT')).toBe('txt')
    expect(extOf('a/.bashrc')).toBe('')
    expect(extOf('noext')).toBe('')
  })
})

describe('editorStore', () => {
  it('openFile：读文件新开 Tab、窗口打开；再开同一文件只切换', async () => {
    const { deps, rpc } = fakeDeps({ 'D:/ws/a.txt': 'hello', 'D:/ws/b.md': '# b' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    await store.openFile('D:/ws/b.md')
    let s = store.getState()
    expect(s.tabs.map(t => t.name)).toEqual(['a.txt', 'b.md'])
    expect(s.activeId).toBe('D:/ws/b.md')
    expect(s.open).toBe(true)
    expect(s.tabs[0]).toMatchObject({ content: 'hello', savedContent: 'hello', dirty: false, loading: false, size: 5 })
    await store.openFile('D:/ws/a.txt')
    s = store.getState()
    expect(s.tabs).toHaveLength(2)
    expect(s.activeId).toBe('D:/ws/a.txt')
    expect((rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(c => c[0] === 'files.read')).toHaveLength(2)
  })

  it('openFile 失败：报错并移除占位 Tab；最后一个 Tab 没了则窗口关闭', async () => {
    const { deps, errors } = fakeDeps({})
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/nope.txt')
    expect(errors[0]).toBe('打开失败：文件不存在')
    expect(store.getState().tabs).toEqual([])
    expect(store.getState().open).toBe(false)
  })

  it('超过上限：只读打开（truncated），setContent 无效，save 拒绝', async () => {
    const big = 'x'.repeat(50)
    const { deps, errors, info } = fakeDeps({ 'D:/ws/big.log': big })
    const store = createEditorStore({ ...deps, maxBytes: 10 })
    await store.openFile('D:/ws/big.log')
    const tab = store.getState().tabs[0]!
    expect(tab.truncated).toBe(true)
    expect(tab.content).toBe('x'.repeat(10))
    expect(info[0]).toContain('只读')
    store.setContent(tab.id, 'changed')
    expect(store.getState().tabs[0]?.dirty).toBe(false)
    expect(await store.save()).toBe(false)
    expect(errors[0]).toContain('只读')
  })

  it('setContent 置脏 / 改回原文清脏；save 写回并清脏；无改动不写', async () => {
    const { deps, writes, info } = fakeDeps({ 'D:/ws/a.txt': 'hello' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'hello!')
    expect(store.getState().tabs[0]?.dirty).toBe(true)
    store.setContent('D:/ws/a.txt', 'hello')
    expect(store.getState().tabs[0]?.dirty).toBe(false)
    expect(await store.save()).toBe(true)
    expect(writes).toEqual([])
    expect(info.at(-1)).toBe('a.txt 无改动')
    store.setContent('D:/ws/a.txt', 'v2')
    expect(await store.save()).toBe(true)
    expect(writes).toEqual([{ path: 'D:/ws/a.txt', content: 'v2' }])
    expect(store.getState().tabs[0]).toMatchObject({ dirty: false, savedContent: 'v2' })
  })

  it('保存期间继续编辑：写盘完成后仍是脏的（不能静默丢掉新敲的字）', async () => {
    let releaseWrite: () => void = () => {}
    const writes: string[] = []
    const rpc = (async (method: string, payload?: Record<string, unknown>) => {
      if (method === 'files.read') return { content: 'v1', size: 2, truncated: false }
      if (method === 'files.write') {
        writes.push(String(payload?.content))
        await new Promise<void>(r => { releaseWrite = r })
        return { bytes: 2 }
      }
      throw new Error('unknown')
    }) as unknown as EditorRpc
    const store = createEditorStore({ rpc, getRoot: () => 'D:/ws' })
    await store.openFile('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'v2')
    const saving = store.save()
    store.setContent('D:/ws/a.txt', 'v2 + more')   // 写盘还没返回
    releaseWrite()
    expect(await saving).toBe(true)
    const tab = store.getState().tabs[0]!
    expect(writes).toEqual(['v2'])
    expect(tab.savedContent).toBe('v2')
    expect(tab.content).toBe('v2 + more')
    expect(tab.dirty).toBe(true)
    store.requestClose('D:/ws/a.txt')
    expect(store.getState().pendingClose).toBe('D:/ws/a.txt')
  })

  it('save 失败：保留脏标记并报错', async () => {
    const { deps, errors } = fakeDeps({ 'D:/ws/a.txt': 'hello' }, { failWrite: true })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'v2')
    expect(await store.save()).toBe(false)
    expect(store.getState().tabs[0]?.dirty).toBe(true)
    expect(errors[0]).toBe('保存失败：磁盘满')
  })

  it('requestClose：干净直接关；关激活 Tab 后激活左邻；脏则进入确认', async () => {
    const { deps } = fakeDeps({ 'D:/ws/a.txt': 'a', 'D:/ws/b.txt': 'b', 'D:/ws/c.txt': 'c' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    await store.openFile('D:/ws/b.txt')
    await store.openFile('D:/ws/c.txt')
    store.activate('D:/ws/b.txt')
    store.requestClose('D:/ws/b.txt')
    expect(store.getState().tabs.map(t => t.name)).toEqual(['a.txt', 'c.txt'])
    expect(store.getState().activeId).toBe('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'dirty')
    store.requestClose('D:/ws/a.txt')
    expect(store.getState().pendingClose).toBe('D:/ws/a.txt')
    expect(store.getState().tabs).toHaveLength(2)
  })

  it('confirmClose：cancel 保留；discard 关掉；save 写回再关', async () => {
    const { deps, writes } = fakeDeps({ 'D:/ws/a.txt': 'a', 'D:/ws/b.txt': 'b' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    await store.openFile('D:/ws/b.txt')
    store.setContent('D:/ws/a.txt', 'a2')
    store.setContent('D:/ws/b.txt', 'b2')
    store.requestClose('D:/ws/a.txt')
    await store.confirmClose('cancel')
    expect(store.getState().pendingClose).toBeNull()
    expect(store.getState().tabs).toHaveLength(2)
    store.requestClose('D:/ws/a.txt')
    await store.confirmClose('discard')
    expect(store.getState().tabs.map(t => t.name)).toEqual(['b.txt'])
    expect(writes).toEqual([])
    store.requestClose('D:/ws/b.txt')
    await store.confirmClose('save')
    expect(writes).toEqual([{ path: 'D:/ws/b.txt', content: 'b2' }])
    expect(store.getState().tabs).toEqual([])
    expect(store.getState().open).toBe(false)
  })

  it('confirmClose(save) 失败时不关 Tab', async () => {
    const { deps } = fakeDeps({ 'D:/ws/a.txt': 'a' }, { failWrite: true })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'a2')
    store.requestClose('D:/ws/a.txt')
    await store.confirmClose('save')
    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().pendingClose).toBeNull()
  })

  it('requestCloseWindow：无脏直接全关；有脏进入 "*" 确认，discard 全关', async () => {
    const { deps } = fakeDeps({ 'D:/ws/a.txt': 'a', 'D:/ws/b.txt': 'b' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    await store.openFile('D:/ws/b.txt')
    store.requestCloseWindow()
    expect(store.getState().tabs).toEqual([])
    await store.openFile('D:/ws/a.txt')
    store.setContent('D:/ws/a.txt', 'x')
    store.requestCloseWindow()
    expect(store.getState().pendingClose).toBe('*')
    await store.confirmClose('discard')
    expect(store.getState().tabs).toEqual([])
    expect(store.getState().open).toBe(false)
  })

  it('minimize / restore / toggleMaximize；openFile 会取消最小化', async () => {
    const { deps } = fakeDeps({ 'D:/ws/a.txt': 'a' })
    const store = createEditorStore(deps)
    await store.openFile('D:/ws/a.txt')
    store.minimize()
    expect(store.getState().minimized).toBe(true)
    store.restore()
    expect(store.getState().minimized).toBe(false)
    store.toggleMaximize()
    expect(store.getState().maximized).toBe(true)
    store.minimize()
    await store.openFile('D:/ws/a.txt')
    expect(store.getState().minimized).toBe(false)
  })
})

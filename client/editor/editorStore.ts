/**
 * F8 浮动编辑器的状态仓库（不含 React 渲染，便于测试）。
 *
 * Tab = 一个本地文件（id = 路径）；窗口开 / 最小化 / 最大化；关 Tab 前的未保存确认状态机。
 * 读写走 files.read / files.write，root 由 getRoot() 提供（= 本地文件面板当前树根）。
 * 窗口几何不在这里（D3：每次打开居中偏下默认尺寸，不记忆）。
 * @module dsh-terminal-manager/client/editor/editorStore
 */

import { useSyncExternalStore } from 'react'

export interface EditorTab {
  /** = path */
  id: string
  path: string
  name: string
  content: string
  /** 最近一次读取 / 保存的内容，用于算 dirty */
  savedContent: string
  dirty: boolean
  truncated: boolean
  size: number
  loading: boolean
  saving: boolean
}

export interface EditorState {
  tabs: EditorTab[]
  activeId: string | null
  open: boolean
  minimized: boolean
  maximized: boolean
  /** 等待用户确认「保存 / 丢弃 / 取消」的 Tab id；'*' = 关闭整个窗口时的全部脏 Tab */
  pendingClose: string | null
}

export type EditorRpc = <T>(method: string, payload?: Record<string, unknown>) => Promise<T>

export interface EditorDeps {
  rpc: EditorRpc
  getRoot: () => string
  /** 读取上限（缺省 10MiB，超出只读打开） */
  maxBytes?: number
  onError?: (message: string) => void
  onInfo?: (message: string) => void
}

export const MAX_EDIT_BYTES = 10 * 1024 * 1024

export function fileNameOf(path: string): string {
  const n = path.replace(/[\\/]+$/, '')
  return n.slice(Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\')) + 1)
}

export function extOf(path: string): string {
  const name = fileNameOf(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

function stripCode(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.replace(/^[A-Z_]+:\s*/, '')
}

export interface EditorStore {
  getState(): EditorState
  subscribe(cb: () => void): () => void
  /** 打开文件：已开则切到该 Tab；否则读文件新开 Tab。窗口显示并取消最小化 */
  openFile(path: string): Promise<void>
  activate(id: string): void
  /** 编辑器内容变化（置脏） */
  setContent(id: string, content: string): void
  /** 保存：写回并清脏；返回 false 表示失败 */
  save(id?: string): Promise<boolean>
  /** 请求关 Tab：脏则进入确认；否则直接关 */
  requestClose(id: string): void
  /** 确认框的三个按钮 */
  confirmClose(action: 'save' | 'discard' | 'cancel'): Promise<void>
  /** 关闭整个窗口（有脏 Tab 则进入确认 '*'） */
  requestCloseWindow(): void
  minimize(): void
  restore(): void
  toggleMaximize(): void
}

export function createEditorStore(deps: EditorDeps): EditorStore {
  let state: EditorState = { tabs: [], activeId: null, open: false, minimized: false, maximized: false, pendingClose: null }
  const listeners = new Set<() => void>()
  function set(patch: Partial<EditorState>): void {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }
  function patchTab(id: string, patch: Partial<EditorTab>): void {
    set({ tabs: state.tabs.map(t => (t.id === id ? { ...t, ...patch } : t)) })
  }
  function removeTabs(ids: readonly string[]): void {
    const remaining = state.tabs.filter(t => !ids.includes(t.id))
    let activeId = state.activeId
    if (activeId !== null && ids.includes(activeId)) {
      const idx = state.tabs.findIndex(t => t.id === activeId)
      // 关掉激活 Tab：优先左邻，其次右邻
      const neighbor = [...state.tabs.slice(0, idx).reverse(), ...state.tabs.slice(idx + 1)].find(t => !ids.includes(t.id))
      activeId = neighbor?.id ?? null
    }
    set({ tabs: remaining, activeId, open: remaining.length > 0 ? state.open : false, minimized: remaining.length > 0 ? state.minimized : false })
  }
  async function saveOne(tab: EditorTab): Promise<boolean> {
    if (tab.saving) return false
    patchTab(tab.id, { saving: true })
    try {
      await deps.rpc('files.write', { root: deps.getRoot(), path: tab.path, content: tab.content })
      patchTab(tab.id, { saving: false, savedContent: tab.content, dirty: false })
      deps.onInfo?.(`已保存 ${tab.name}`)
      return true
    } catch (error) {
      patchTab(tab.id, { saving: false })
      deps.onError?.(`保存失败：${stripCode(error)}`)
      return false
    }
  }

  return {
    getState: () => state,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },

    async openFile(path) {
      const existing = state.tabs.find(t => t.id === path)
      if (existing !== undefined) {
        set({ activeId: path, open: true, minimized: false })
        return
      }
      const tab: EditorTab = {
        id: path, path, name: fileNameOf(path), content: '', savedContent: '', dirty: false,
        truncated: false, size: 0, loading: true, saving: false,
      }
      set({ tabs: [...state.tabs, tab], activeId: path, open: true, minimized: false })
      try {
        const r = await deps.rpc<{ content: string; size: number; truncated: boolean }>('files.read', {
          root: deps.getRoot(), path, maxBytes: deps.maxBytes ?? MAX_EDIT_BYTES,
        })
        patchTab(path, { content: r.content, savedContent: r.content, size: r.size, truncated: r.truncated, loading: false })
        if (r.truncated) deps.onInfo?.(`${tab.name} 超过 10MB，已按只读打开（只显示前 10MB）`)
      } catch (error) {
        deps.onError?.(`打开失败：${stripCode(error)}`)
        removeTabs([path])
      }
    },

    activate(id) {
      if (state.tabs.some(t => t.id === id)) set({ activeId: id })
    },

    setContent(id, content) {
      const tab = state.tabs.find(t => t.id === id)
      if (tab === undefined || tab.truncated) return
      patchTab(id, { content, dirty: content !== tab.savedContent })
    },

    async save(id) {
      const target = id ?? state.activeId
      const tab = state.tabs.find(t => t.id === target)
      if (tab === undefined) return false
      if (tab.truncated) { deps.onError?.('只读打开的文件不能保存'); return false }
      if (!tab.dirty) { deps.onInfo?.(`${tab.name} 无改动`); return true }
      return saveOne(tab)
    },

    requestClose(id) {
      const tab = state.tabs.find(t => t.id === id)
      if (tab === undefined) return
      if (tab.dirty) set({ pendingClose: id })
      else removeTabs([id])
    },

    async confirmClose(action) {
      const pending = state.pendingClose
      if (pending === null) return
      if (action === 'cancel') { set({ pendingClose: null }); return }
      const targets = pending === '*' ? state.tabs.filter(t => t.dirty) : state.tabs.filter(t => t.id === pending)
      if (action === 'save') {
        for (const t of targets) {
          const ok = await saveOne(state.tabs.find(x => x.id === t.id) ?? t)
          if (!ok) { set({ pendingClose: null }); return }
        }
      }
      set({ pendingClose: null })
      removeTabs(pending === '*' ? state.tabs.map(t => t.id) : [pending])
    },

    requestCloseWindow() {
      if (state.tabs.some(t => t.dirty)) set({ pendingClose: '*' })
      else removeTabs(state.tabs.map(t => t.id))
    },

    minimize() { set({ minimized: true }) },
    restore() { set({ minimized: false, open: state.tabs.length > 0 }) },
    toggleMaximize() { set({ maximized: !state.maximized }) },
  }
}

export function useEditorState(store: EditorStore): EditorState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

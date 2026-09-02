/**
 * F7 本地文件面板的状态与逻辑（不含 React 渲染，便于测试）。
 *
 * 树根 root：来自后端 Config（files.root），用户「换目录」后记在 localStorage；
 * 当前目录 cwd 始终在 root 内；列表经 files.tree 懒加载一层。
 * @module dsh-terminal-manager/client/files/localFs
 */

import { useSyncExternalStore } from 'react'

export interface FileEntryView {
  name: string
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

export interface LocalFsState {
  root: string
  cwd: string
  entries: FileEntryView[]
  selected: string | null
  loading: boolean
  error: string | null
  expanded: boolean
  /** init 是否已完成（root 已知） */
  ready: boolean
}

export type RpcFn = <T>(method: string, payload?: Record<string, unknown>) => Promise<T>

export interface LocalFsDeps {
  rpc: RpcFn
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
}

const KEY_ROOT = 'tm.files.root'
const KEY_EXPANDED = 'tm.files.expanded'

// ── 纯函数 ──

/** 统一成 / 分隔、去掉末尾分隔（盘符根 "D:/" 保留） */
function norm(p: string): string {
  const s = p.replace(/[\\/]+/g, '/')
  return s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s) ? s.slice(0, -1) : s
}

/** 路径比较键（Windows 大小写不敏感） */
function key(p: string): string {
  const n = norm(p)
  return /^[A-Za-z]:/.test(n) ? n.toLowerCase() : n
}

export function isSameOrInside(root: string, path: string): boolean {
  const r = key(root)
  const p = key(path)
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/** 父目录；到顶（盘符根或 /）返回自身 */
export function parentDir(path: string): string {
  const n = norm(path)
  if (n === '/' || /^[A-Za-z]:\/?$/.test(n)) return n
  const i = n.lastIndexOf('/')
  if (i <= 0) return n.startsWith('/') ? '/' : n
  const parent = n.slice(0, i)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

export function baseName(path: string): string {
  const n = norm(path)
  if (n === '/' || /^[A-Za-z]:\/?$/.test(n)) return n
  return n.slice(n.lastIndexOf('/') + 1)
}

export interface Crumb { label: string; path: string }

/** 面包屑：第一段 = 树根（显示根目录名），后续为相对路径各段。cwd 不在 root 内时只显示 cwd 本身。 */
export function breadcrumbs(root: string, cwd: string): Crumb[] {
  if (!isSameOrInside(root, cwd)) return [{ label: cwd, path: cwd }]
  const r = norm(root)
  const crumbs: Crumb[] = [{ label: baseName(r), path: r }]
  const rel = norm(cwd).slice(r.length).replace(/^\//, '')
  if (rel.length === 0) return crumbs
  let acc = r
  for (const seg of rel.split('/')) {
    acc = acc.endsWith('/') ? `${acc}${seg}` : `${acc}/${seg}`
    crumbs.push({ label: seg, path: acc })
  }
  return crumbs
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** RpcError 的 message 形如 "CODE: 说明"，取说明部分给人看 */
export function humanError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.replace(/^[A-Z_]+:\s*/, '')
}

// ── store ──

export interface LocalFsStore {
  getState(): LocalFsState
  subscribe(cb: () => void): () => void
  /** 首次：取树根（localStorage 优先，其次后端 Config）并列出根目录 */
  init(): Promise<void>
  setExpanded(expanded: boolean): void
  toggleExpanded(): void
  refresh(): Promise<void>
  /** 进入目录（必须在 root 内） */
  enter(path: string): Promise<void>
  /** 上一级（到 root 为止） */
  up(): Promise<void>
  select(path: string | null): void
  /** 换树根：cwd 同步到新根并记忆 */
  setRoot(path: string): Promise<void>
}

export function createLocalFsStore(deps: LocalFsDeps): LocalFsStore {
  const storage = deps.storage
  let state: LocalFsState = {
    root: '', cwd: '', entries: [], selected: null, loading: false, error: null,
    expanded: storage?.getItem(KEY_EXPANDED) === '1',
    ready: false,
  }
  const listeners = new Set<() => void>()
  function set(patch: Partial<LocalFsState>): void {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }
  let loadSeq = 0
  async function load(cwd: string): Promise<void> {
    const seq = ++loadSeq
    set({ loading: true, error: null, cwd, selected: null })
    try {
      const entries = await deps.rpc<FileEntryView[]>('files.tree', { root: state.root, path: cwd })
      if (seq !== loadSeq) return
      set({ entries, loading: false })
    } catch (error) {
      if (seq !== loadSeq) return
      set({ entries: [], loading: false, error: humanError(error) })
    }
  }
  return {
    getState: () => state,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    async init() {
      if (state.ready) return
      let root = storage?.getItem(KEY_ROOT) ?? ''
      if (root.length === 0) {
        try {
          root = (await deps.rpc<{ root: string }>('files.root')).root
        } catch (error) {
          set({ error: humanError(error) })
          return
        }
      }
      set({ root, ready: true })
      await load(root)
    },
    setExpanded(expanded) {
      set({ expanded })
      storage?.setItem(KEY_EXPANDED, expanded ? '1' : '0')
    },
    toggleExpanded() { this.setExpanded(!state.expanded) },
    refresh: () => load(state.cwd),
    async enter(path) {
      if (!isSameOrInside(state.root, path)) return
      await load(path)
    },
    async up() {
      if (key(state.cwd) === key(state.root)) return
      const parent = parentDir(state.cwd)
      await load(isSameOrInside(state.root, parent) ? parent : state.root)
    },
    select(path) { set({ selected: path }) },
    async setRoot(path) {
      set({ root: path })
      storage?.setItem(KEY_ROOT, path)
      await load(path)
    },
  }
}

export function useLocalFsState(store: LocalFsStore): LocalFsState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

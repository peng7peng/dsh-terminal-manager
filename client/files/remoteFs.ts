/**
 * F7b 远端文件面板的状态与逻辑（不含 React 渲染，便于测试）。
 *
 * 远端无树根概念：cwd 从 / 出发（每会话记忆），列表经 files.remoteTree 懒加载一层。
 * 传输三类入口都汇到 transferId（前端生成、服务端不透明回显），进度按 transferId 过滤：
 * - 本地源上传 files.uploadLocal（本地面板选中 / 编辑器当前文件联动，host 端读盘）；
 * - 浏览器文件直传 HTTP /files/upload（OS 拖拽，XHR raw，upload.onprogress）；
 * - 下载到工作区 files.downloadToLocal（本地面板联动，路径②，行内进度条）；
 * - 另存为 GET /files/download（路径③，导航式下载，终态帧是唯一完成信号）。
 * @module dsh-terminal-manager/client/files/remoteFs
 */

import { useSyncExternalStore } from 'react'
import { baseName, humanError, type FileEntryView } from './localFs.ts'
import type { FileProgressFrame } from '../ws.ts'

export type TransferOp = 'upload' | 'download'

/** 一条传输记录（进行中或刚结束；结束的保留便于看结果，超过上限裁掉最旧的）。 */
export interface TransferItem {
  transferId: string
  sessionId: string
  op: TransferOp
  /** 显示名（远端文件名，重命名后为最终名） */
  name: string
  remotePath: string
  /** 下载到工作区时有 */
  localPath?: string
  transferred: number
  total?: number
  percent?: number
  done: boolean
  ok?: boolean
  error?: string
}

/** 同名冲突待决策（本期只做单文件；覆盖 / 跳过 / 重命名）。 */
export interface ConflictDecision {
  op: TransferOp
  /** 目标名 */
  name: string
}

export type ConflictChoice = 'overwrite' | 'skip' | 'rename'
/** 发起结果：started = 已进传输；conflict = 等用户决策；blocked = 前置条件不满足（未选会话等） */
export type TransferStart = 'started' | 'conflict' | 'blocked'

/** 本地源上传的文件（本地面板选中项 / 编辑器当前 Tab）。 */
export interface UploadLocalFile {
  root: string
  path: string
  name: string
  size?: number
}

export type RpcFn = <T>(method: string, payload?: Record<string, unknown>) => Promise<T>

/** 浏览器文件直传（XHR 才有 upload.onprogress；测试注入假实现）。 */
export type HttpUpload = (args: {
  url: string
  body: Blob
  onProgress: (transferred: number, total?: number) => void
}) => Promise<void>

export interface RemoteFsDeps {
  rpc: RpcFn
  /** 浏览器文件直传实现；缺省 XHR */
  httpUpload?: HttpUpload
  /** 本地面板当前目录里的名字集合（下载②同名冲突检查用） */
  localNames?: () => Set<string>
  /** 本地面板当前目录（下载②目标 root + cwd）；未就绪返回 undefined */
  localTarget?: () => { root: string; path: string } | undefined
  /** 下载②成功后刷新本地面板列表 */
  localRefresh?: () => void
  /** 另存为的导航实现；缺省 <a download> 点击 */
  navigate?: (url: string) => void
  /** UI 偏好存储（expanded）；缺省不记忆 */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  /** transferId 生成（测试可注入） */
  uuid?: () => string
}

export interface RemoteFsState {
  sessionId: string | null
  cwd: string
  entries: FileEntryView[]
  selected: string | null
  loading: boolean
  error: string | null
  expanded: boolean
  transfers: TransferItem[]
  conflict: ConflictDecision | null
}

const KEY_EXPANDED = 'tm.rfiles.expanded'
const MAX_TRANSFERS = 30

// ── 纯函数 ──

/** 远端 POSIX 拼接（cwd 可能是 /）。 */
export function remoteJoin(dir: string, name: string): string {
  const d = dir.length > 0 && dir.endsWith('/') ? dir : `${dir}/`
  return `${d}${name}`
}

/** 远端父目录；到顶（/）返回自身。 */
export function remoteParent(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** 本地目录拼接（Windows / POSIX；盘符根 "D:/" 自带斜杠）。 */
export function localJoin(dir: string, name: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`
}

/** 重命名候选：a.txt → a (1).txt → a (2).txt …（资源管理器风格；`.hidden` 整体当名字）。 */
export function renameCandidate(name: string, existing: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!existing.has(candidate)) return candidate
  }
  return `${stem} (重命名)${ext}`
}

// ── 缺省实现（浏览器环境）──

/** 另存为 = 导航式 GET 下载；同源 <a download> 触发浏览器保存。 */
function defaultNavigate(url: string): void {
  if (typeof document === 'undefined') return
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function xhrUpload(args: { url: string; body: Blob; onProgress: (transferred: number, total?: number) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', args.url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) args.onProgress(e.loaded, e.total) }
    xhr.onload = () => {
      // 裸信封 {ok, value|error}（见 remotes.ts handleFileUpload）
      let body: { ok?: boolean; error?: { code: string; message: string } } = {}
      try { body = JSON.parse(xhr.responseText) as typeof body } catch { /* 非 JSON 按 HTTP 状态处理 */ }
      if (xhr.status === 200 && body.ok === true) { resolve(); return }
      const e = body.error
      const error = new Error(e !== undefined ? `${e.code}: ${e.message}` : `HTTP_${xhr.status}: 上传失败`)
      reject(error)
    }
    xhr.onerror = () => reject(new Error('NETWORK: 上传请求失败'))
    xhr.send(args.body)
  })
}

// ── store ──

export interface RemoteFsStore {
  getState(): RemoteFsState
  subscribe(cb: () => void): () => void
  /** 切换会话（null = 清空）；每会话记忆 cwd */
  setSession(sessionId: string | null): Promise<void>
  refresh(): Promise<void>
  enter(path: string): Promise<void>
  up(): Promise<void>
  select(path: string | null): void
  setExpanded(expanded: boolean): void
  toggleExpanded(): void
  /** 本地源上传（本地面板选中 / 编辑器当前文件；同名冲突走决策） */
  uploadLocalFile(file: UploadLocalFile): TransferStart
  /** 浏览器文件直传（OS 拖拽；本期单文件） */
  uploadBrowserFile(file: File): TransferStart
  /** 下载到本地面板当前目录（路径②；同名冲突查本地面板） */
  downloadToWorkspace(remotePath: string): TransferStart
  /** 另存为（路径③）：导航式 GET 下载，保存位置与同名由浏览器管 */
  saveAs(remotePath: string): TransferStart
  resolveConflict(choice: ConflictChoice): void
  /** /term-io file-progress 帧入口（TerminalWorkspace 接线；别人的传输自动忽略） */
  pushFrame(frame: FileProgressFrame): void
  /** 清掉已结束的传输行 */
  clearFinished(): void
}

export function createRemoteFsStore(deps: RemoteFsDeps): RemoteFsStore {
  const uuid = deps.uuid ?? (() => crypto.randomUUID())
  const storage = deps.storage
  let state: RemoteFsState = {
    sessionId: null, cwd: '/', entries: [], selected: null, loading: false,
    error: null,
    expanded: (() => { try { return storage?.getItem(KEY_EXPANDED) === '1' } catch { return false } })(),
    transfers: [], conflict: null,
  }
  const listeners = new Set<() => void>()
  function set(patch: Partial<RemoteFsState>): void {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }
  const cwdBySession = new Map<string, string>()
  /** 本 store 发起的 transferId（进度帧是广播的，别人的传输忽略） */
  const mine = new Set<string>()
  let loadSeq = 0
  /** 冲突待决策的续传闭包（决策时目标目录可能已变，sessionId/cwd 在发起时捕获） */
  let pending: { conflict: ConflictDecision; existing: ReadonlySet<string>; proceed: (finalName: string) => void } | undefined

  async function load(sid: string, cwd: string): Promise<void> {
    const seq = ++loadSeq
    set({ loading: true, error: null, selected: null })
    try {
      const entries = await deps.rpc<FileEntryView[]>('files.remoteTree', { sessionId: sid, path: cwd })
      if (seq !== loadSeq) return
      // 成功才提交 cwd（进不去的目录不改面包屑、不记会话目录）
      cwdBySession.set(sid, cwd)
      set({ entries, cwd, loading: false })
    } catch (error) {
      if (seq !== loadSeq) return
      set({ entries: [], loading: false, error: humanError(error) })
    }
  }

  /** 上传成功后若用户还停在目标目录，自动刷一次列表让新文件出现。 */
  function refreshIfStillThere(sid: string, dir: string): void {
    if (state.sessionId === sid && state.cwd === dir) void load(sid, dir)
  }

  function beginTransfer(item: Omit<TransferItem, 'transferred' | 'done'>): void {
    mine.add(item.transferId)
    const rest = state.transfers.filter(t => t.transferId !== item.transferId)
    set({ transfers: [...rest, { ...item, transferred: 0, done: false }].slice(-MAX_TRANSFERS) })
  }
  function patchTransfer(transferId: string, patch: Partial<TransferItem>): void {
    if (!mine.has(transferId)) return
    set({ transfers: state.transfers.map(t => t.transferId === transferId ? { ...t, ...patch } : t) })
  }
  function finishTransfer(transferId: string, ok: boolean, error?: string, transferred?: number): void {
    if (!mine.has(transferId)) return
    set({
      transfers: state.transfers.map(t => t.transferId === transferId
        ? { ...t, done: true, ok, ...(error !== undefined ? { error } : {}), ...(transferred !== undefined ? { transferred } : {}) }
        : t),
    })
  }

  function runUploadLocal(sid: string, cwd: string, file: UploadLocalFile, finalName: string): void {
    const transferId = uuid()
    const remotePath = remoteJoin(cwd, finalName)
    beginTransfer({ transferId, sessionId: sid, op: 'upload', name: finalName, remotePath, total: file.size })
    void (async () => {
      try {
        const r = await deps.rpc<{ bytes: number }>('files.uploadLocal', {
          sessionId: sid, remotePath, root: file.root, path: file.path, transferId,
        })
        finishTransfer(transferId, true, undefined, r.bytes)
        refreshIfStillThere(sid, remoteParent(remotePath))
      } catch (error) {
        finishTransfer(transferId, false, humanError(error))
      }
    })()
  }

  function runUploadBrowser(sid: string, cwd: string, file: File, finalName: string): void {
    const transferId = uuid()
    const remotePath = remoteJoin(cwd, finalName)
    beginTransfer({ transferId, sessionId: sid, op: 'upload', name: finalName, remotePath, total: file.size })
    const upload = deps.httpUpload ?? xhrUpload
    void upload({
      url: `/term-manager/files/upload?sessionId=${encodeURIComponent(sid)}&remotePath=${encodeURIComponent(remotePath)}&transferId=${encodeURIComponent(transferId)}`,
      body: file,
      onProgress: (transferred, total) => applyProgressFrame({ kind: 'file-progress', transferId, transferred, ...(total !== undefined ? { total } : {}) }),
    }).then(
      () => { finishTransfer(transferId, true); refreshIfStillThere(sid, remoteParent(remotePath)) },
      (error: unknown) => finishTransfer(transferId, false, humanError(error)),
    )
  }

  function runDownloadToLocal(sid: string, remotePath: string, target: { root: string; path: string }, finalName: string): void {
    const transferId = uuid()
    const localPath = localJoin(target.path, finalName)
    beginTransfer({ transferId, sessionId: sid, op: 'download', name: finalName, remotePath, localPath })
    void (async () => {
      try {
        const r = await deps.rpc<{ bytes: number }>('files.downloadToLocal', {
          sessionId: sid, remotePath, root: target.root, path: localPath, transferId,
        })
        finishTransfer(transferId, true, undefined, r.bytes)
        deps.localRefresh?.()
      } catch (error) {
        finishTransfer(transferId, false, humanError(error))
      }
    })()
  }

  /** 当前远端目录里已被占用的名字（文件和目录都算冲突）。 */
  function remoteNames(): Set<string> {
    return new Set(state.entries.map(e => e.name))
  }

  /** 进度帧 → 行更新（别人的 transferId 忽略）。失败终态帧的 transferred=0 不采纳（审查 L4：别把已传字节清零）。 */
  function applyProgressFrame(frame: FileProgressFrame): void {
    if (frame.kind !== 'file-progress' || !mine.has(frame.transferId)) return
    const patch: Partial<TransferItem> = {}
    if (frame.transferred !== undefined && !(frame.done === true && frame.ok === false)) patch.transferred = frame.transferred
    if (frame.total !== undefined) patch.total = frame.total
    const percent = frame.percent ?? (frame.total !== undefined && frame.total > 0 && frame.transferred !== undefined
      ? Math.min(100, Math.round((frame.transferred / frame.total) * 100))
      : undefined)
    if (percent !== undefined) patch.percent = percent
    if (frame.done === true) {
      patch.done = true
      patch.ok = frame.ok ?? false
      if (frame.error !== undefined) patch.error = frame.error
    }
    patchTransfer(frame.transferId, patch)
  }

  return {
    getState: () => state,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    async setSession(sessionId) {
      if (sessionId === null) {
        loadSeq += 1
        pending = undefined
        // 传输行保留（审查 M3：掉线瞬间清空会吞掉在途传输的终态反馈——
        // 服务端的失败终态帧随后到达，行上能看到 ✗ 与原因；cleared 只清界面状态）
        set({ sessionId: null, cwd: '/', entries: [], selected: null, loading: false, error: null, conflict: null })
        return
      }
      if (state.sessionId === sessionId) return
      const cwd = cwdBySession.get(sessionId) ?? '/'
      pending = undefined // 冲突决策绑定旧会话/旧目录，切走即作废（审查 L2）
      set({ sessionId, ...(state.conflict !== null ? { conflict: null } : {}) })
      await load(sessionId, cwd)
    },
    refresh: () => {
      const sid = state.sessionId
      return sid === null ? Promise.resolve() : load(sid, state.cwd)
    },
    async enter(path) {
      const sid = state.sessionId
      if (sid === null || !path.startsWith('/') || path === state.cwd) return
      await load(sid, path)
    },
    async up() {
      const sid = state.sessionId
      if (sid === null || state.cwd === '/') return
      await load(sid, remoteParent(state.cwd))
    },
    select(path) { set({ selected: path }) },
    setExpanded(expanded) {
      set({ expanded })
      try { storage?.setItem(KEY_EXPANDED, expanded ? '1' : '0') } catch { /* ignore */ }
    },
    toggleExpanded() { this.setExpanded(!state.expanded) },

    uploadLocalFile(file) {
      const sid = state.sessionId
      if (sid === null) return 'blocked'
      const cwd = state.cwd
      const existing = remoteNames()
      if (existing.has(file.name)) {
        pending = { conflict: { op: 'upload', name: file.name }, existing, proceed: (finalName) => runUploadLocal(sid, cwd, file, finalName) }
        set({ conflict: pending.conflict })
        return 'conflict'
      }
      runUploadLocal(sid, cwd, file, file.name)
      return 'started'
    },

    uploadBrowserFile(file) {
      const sid = state.sessionId
      if (sid === null) return 'blocked'
      const cwd = state.cwd
      const existing = remoteNames()
      if (existing.has(file.name)) {
        pending = { conflict: { op: 'upload', name: file.name }, existing, proceed: (finalName) => runUploadBrowser(sid, cwd, file, finalName) }
        set({ conflict: pending.conflict })
        return 'conflict'
      }
      runUploadBrowser(sid, cwd, file, file.name)
      return 'started'
    },

    downloadToWorkspace(remotePath) {
      const sid = state.sessionId
      const target = deps.localTarget?.()
      if (sid === null || target === undefined) return 'blocked'
      const name = baseName(remotePath)
      const existing = deps.localNames?.() ?? new Set<string>()
      if (existing.has(name)) {
        pending = { conflict: { op: 'download', name }, existing, proceed: (finalName) => runDownloadToLocal(sid, remotePath, target, finalName) }
        set({ conflict: pending.conflict })
        return 'conflict'
      }
      runDownloadToLocal(sid, remotePath, target, name)
      return 'started'
    },

    saveAs(remotePath) {
      const sid = state.sessionId
      if (sid === null) return 'blocked'
      const transferId = uuid()
      beginTransfer({ transferId, sessionId: sid, op: 'download', name: baseName(remotePath), remotePath })
      ;(deps.navigate ?? defaultNavigate)(`/term-manager/files/download?sessionId=${encodeURIComponent(sid)}&remotePath=${encodeURIComponent(remotePath)}&transferId=${encodeURIComponent(transferId)}`)
      return 'started'
    },

    resolveConflict(choice) {
      const p = pending
      pending = undefined
      set({ conflict: null })
      if (p === undefined || choice === 'skip') return
      p.proceed(choice === 'overwrite' ? p.conflict.name : renameCandidate(p.conflict.name, p.existing))
    },

    pushFrame(frame) { applyProgressFrame(frame) },

    clearFinished() {
      const kept = state.transfers.filter(t => !t.done)
      // 同步收缩 mine：已结束行的 id 不再放行帧（防集合无界增长）
      for (const id of mine) {
        if (!kept.some(t => t.transferId === id)) mine.delete(id)
      }
      set({ transfers: kept })
    },
  }
}

export function useRemoteFsState(store: RemoteFsStore): RemoteFsState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

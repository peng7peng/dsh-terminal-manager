/**
 * F7 本地文件面板 —— 广播栏下方的收起条；展开后：工具栏（只放图标，悬停出提示）+ 面包屑 + 列表。
 * 单击选中、双击目录进入、双击文件：文本类交给 onOpenFile（编辑器），其余用系统默认程序打开；
 * 右键菜单两种打开方式都有。工具栏 / 面包屑不换行、可横向滑动。远端面板（S5）复用 FileList。
 * @module dsh-terminal-manager/client/files/FilePanel
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronRightOutline14, IconChevronUpOutline14, IconFolderClose16, IconFolderOpen16, IconGoalOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { rpc } from '../rpc.ts'
import { toast } from '../toast.ts'
import { ContextMenu } from '../tc/ContextMenu.tsx'
import { breadcrumbs, createLocalFsStore, formatSize, humanError, parentDir, samePath, useLocalFsState, type FileEntryView, type LocalFsStore } from './localFs.ts'
import { openTargetFor } from './openRule.ts'
import { remoteFsStore } from './RemoteFilePanel.tsx'
import { useRemoteFsState } from './remoteFs.ts'

let singleton: LocalFsStore | undefined
/** 模块级单例：面板收起 / 重开不丢状态。 */
export function localFsStore(): LocalFsStore {
  if (singleton === undefined) {
    singleton = createLocalFsStore({ rpc, storage: typeof localStorage === 'undefined' ? undefined : localStorage })
  }
  return singleton
}

/** 用系统默认程序打开（Excel / Word / PDF …）。 */
export async function openWithSystemApp(root: string, path: string, name: string): Promise<void> {
  try {
    await rpc('files.open', { root, path })
    toast(`已交给系统默认程序打开：${name}`)
  } catch (error) {
    toast(`打开失败：${humanError(error)}`, 'error')
  }
}

/** 文件列表（本地 / 远端共用）。 */
export function FileList(props: {
  entries: FileEntryView[]
  selected: string | null
  loading: boolean
  error: string | null
  onSelect: (path: string) => void
  onOpenDir: (path: string) => void
  onOpenFile?: (entry: FileEntryView) => void
  onContextMenu?: (entry: FileEntryView, e: React.MouseEvent) => void
}): React.JSX.Element {
  const { entries, selected, loading, error, onSelect, onOpenDir, onOpenFile, onContextMenu } = props
  if (error !== null) return <div className="tm-fpErr">{error}</div>
  if (loading && entries.length === 0) return <div className="tm-fpEmpty">加载中…</div>
  if (entries.length === 0) return <div className="tm-fpEmpty">（空目录）</div>
  return (
    <div className="tm-fpList">
      {entries.map(e => {
        const isDir = e.kind === 'dir'
        const target = e.kind === 'file' ? openTargetFor(e.name) : null
        return (
          <div
            key={e.path}
            className={`tm-fpRow ${selected === e.path ? 'sel' : ''}`}
            onClick={() => onSelect(e.path)}
            onDoubleClick={() => { if (isDir) onOpenDir(e.path); else if (e.kind === 'file') onOpenFile?.(e) }}
            onContextMenu={(ev) => { if (onContextMenu !== undefined) { ev.preventDefault(); onSelect(e.path); onContextMenu(e, ev) } }}
            title={isDir ? `${e.path}\n双击进入` : target === 'editor' ? `${e.path}\n双击在编辑器打开` : target === 'system' ? `${e.path}\n双击用系统默认程序打开` : e.path}
          >
            <span className="ico">{isDir ? '📁' : e.kind === 'symlink' ? '🔗' : target === 'system' ? '📎' : '📄'}</span>
            <span className="nm">{e.name}</span>
            <span className="sz">{isDir ? '文件夹' : formatSize(e.size)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 「换目录」选择器：从当前树根出发浏览子目录，或直接输入路径。 */
function DirPicker(props: { initial: string; onCancel: () => void; onPick: (path: string) => void }): React.JSX.Element {
  const [path, setPath] = useState(props.initial)
  const [input, setInput] = useState(props.initial)
  const [dirs, setDirs] = useState<FileEntryView[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load(p: string): Promise<void> {
    setError(null)
    try {
      const list = await rpc<FileEntryView[]>('files.dirs', { path: p })
      setDirs(list)
      setPath(p)
      setInput(p)
    } catch (err) {
      setError(humanError(err))
    }
  }
  useEffect(() => { void load(props.initial) }, [props.initial])

  return (
    <div className="tm-mask" onClick={props.onCancel}>
      <div className="tm-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-mHead"><IconFolderOpen16 /> 选择本地根目录</div>
        <div className="tm-mBody">
          <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void load(input.trim()) }} placeholder="输入目录路径后回车" />
          <div className="tm-mRow click" onClick={() => void load(parentDir(path))}><IconChevronUpOutline14 /> 上一级</div>
          {error !== null && <div className="tm-fpErr">{error}</div>}
          {dirs.map(d => (
            <div key={d.path} className="tm-mRow click" onDoubleClick={() => void load(d.path)} onClick={() => setInput(d.path)} title="双击进入">
              <IconFolderClose16 /> {d.name}
            </div>
          ))}
          {error === null && dirs.length === 0 && <div className="tm-fpEmpty">（无子目录）</div>}
        </div>
        <div className="tm-mNote">文件读写范围 = 选定的根目录及其子目录（切换根 = 授权该目录）</div>
        <div className="tm-mFoot">
          <button className="tm-btnPlain" onClick={props.onCancel}>取消</button>
          <button className="tm-btnPrimary" onClick={() => props.onPick(input.trim() || path)}>选择此目录</button>
        </div>
      </div>
    </div>
  )
}

const HEIGHT_KEY = 'tm.files.height'
export const PANEL_MIN_H = 120
export const PANEL_DEFAULT_H = 220

/** 面板高度上限：视口的 70%（留出终端网格） */
export function clampPanelHeight(h: number, viewportH: number): number {
  return Math.round(Math.min(Math.max(h, PANEL_MIN_H), Math.max(PANEL_MIN_H, viewportH * 0.7)))
}

function readStoredHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(v) && v > 0 ? v : PANEL_DEFAULT_H
  } catch { return PANEL_DEFAULT_H }
}

export function FilePanel(props: { onOpenFile: (entry: FileEntryView) => void }): React.JSX.Element {
  const store = localFsStore()
  const s = useLocalFsState(store)
  // S5 联动：上传 = 本地选中 → 远端当前目录；下载 = 远端选中 → 本地当前目录
  const remoteStore = remoteFsStore()
  const remote = useRemoteFsState(remoteStore)
  const remoteSelected = remote.entries.find(e => e.path === remote.selected) ?? null
  const [picking, setPicking] = useState(false)
  const [ctx, setCtx] = useState<{ entry: FileEntryView; x: number; y: number } | null>(null)
  const [height, setHeight] = useState<number>(() => (typeof localStorage === 'undefined' ? PANEL_DEFAULT_H : readStoredHeight()))
  const [resizing, setResizing] = useState(false)
  /** 顶栏拖动：记录起点；松手时没动过 = 点击（展开 / 收起），动过 = 改高度 */
  const dragRef = useRef<{ y: number; h: number; moved: boolean } | null>(null)

  useEffect(() => { void store.init() }, [store])

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // 必须 preventDefault：否则按下图标/文字可能触发浏览器原生拖拽，
    // 拖到终端上松手会被 xterm 的 drop 处理当成输入打出去（拖动顶栏却往终端"打字"）
    e.preventDefault()
    dragRef.current = { y: e.clientY, h: height, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d === null || !s.expanded) return
    const dy = e.clientY - d.y
    if (!d.moved && Math.abs(dy) < 4) return
    d.moved = true
    setResizing(true)
    // 往上拖 = 面板变高
    setHeight(clampPanelHeight(d.h - dy, window.innerHeight))
  }
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d === null) return
    if (d.moved) {
      setResizing(false)
      try { localStorage.setItem(HEIGHT_KEY, String(clampPanelHeight(d.h - (e.clientY - d.y), window.innerHeight))) } catch { /* ignore */ }
    } else {
      store.toggleExpanded()
    }
  }

  const crumbs = s.ready ? breadcrumbs(s.root, s.cwd) : []
  const atRoot = crumbs.length <= 1

  /** 双击：文本进编辑器，其余交给系统 */
  const openEntry = (entry: FileEntryView, how?: 'editor' | 'system'): void => {
    const target = how ?? openTargetFor(entry.name)
    if (target === 'editor') props.onOpenFile(entry)
    else void openWithSystemApp(s.root, entry.path, entry.name)
  }

  /** 联动上传：本地选中的文件 → 远端当前目录（host 端读盘，经 files.uploadLocal） */
  const uploadSelected = (): void => {
    const entry = s.entries.find(e => e.path === s.selected)
    if (entry === undefined || entry.kind !== 'file') return
    const r = remoteStore.uploadLocalFile({ root: s.root, path: entry.path, name: entry.name, size: entry.size })
    if (r === 'started') toast(`已开始上传 ${entry.name}（进度见远端面板传输条）`)
    else if (r === 'blocked') toast('无法上传：请先在远端面板选择在线 SSH 会话', 'error')
  }
  /** 联动下载：远端选中的文件 → 本地当前目录（路径② downloadToLocal，行内进度条） */
  const downloadFromRemote = (): void => {
    if (remoteSelected === null || remoteSelected.kind !== 'file') return
    const r = remoteStore.downloadToWorkspace(remoteSelected.path)
    if (r === 'started') toast(`已开始下载 ${remoteSelected.name} → ${s.cwd}（进度见远端面板传输条）`)
    else if (r === 'blocked') toast('无法下载：远端面板未选择会话，或本地目录未就绪', 'error')
  }

  return (
    <div className={`tm-fpanel ${s.expanded ? 'open' : ''} ${resizing ? 'resizing' : ''}`}>
      <div
        className="tm-fpBar"
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={() => { dragRef.current = null; setResizing(false) }}
        title={s.expanded ? '点击收起；上下拖动改面板高度' : '点击展开'}
      >
        <span className="arrow"><IconChevronRightOutline14 /></span>
        <span>📁 本地文件</span>
        <span className="sub">{s.ready ? s.cwd : '…'}</span>
      </div>
      {s.expanded && (
        <div className="tm-fpBody" style={{ height }}>
          <div className="tm-fpToolbar">
            <button className="tm-tbtn icon" disabled={atRoot} onClick={() => void store.up()} title="上一级" aria-label="上一级"><IconChevronUpOutline14 /></button>
            <button className="tm-tbtn icon" onClick={() => setPicking(true)} title="换目录（切换本地根目录）" aria-label="换目录"><IconFolderOpen16 /></button>
            <button
              className="tm-tbtn icon"
              disabled={!s.ready || s.workspaceRoot.length === 0 || samePath(s.root, s.workspaceRoot)}
              onClick={() => { void store.goWorkspace().then(() => toast('已回到工作区目录')) }}
              title="回到工作区目录（Config 里配置的 workspaceRoot）"
              aria-label="回到工作区目录"
            ><IconGoalOutline16 /></button>
            <button className="tm-tbtn icon" onClick={() => { void store.refresh(); toast('本地列表已刷新') }} title="刷新" aria-label="刷新"><IconRefreshOutline14 /></button>
            <button
              className="tm-tbtn icon"
              disabled={remote.sessionId === null || s.selected === null || (s.entries.find(e => e.path === s.selected)?.kind ?? 'dir') !== 'file'}
              onClick={uploadSelected}
              title="上传选中文件到远端当前目录（需先在远端面板选择 SSH 会话）"
              aria-label="上传到设备"
            >⬆</button>
            <button
              className="tm-tbtn icon"
              disabled={remote.sessionId === null || !s.ready || remoteSelected === null || remoteSelected.kind !== 'file'}
              onClick={downloadFromRemote}
              title="把远端面板选中的文件下载到本地当前目录"
              aria-label="从设备下载"
            >⬇</button>
            <span className="hint">双击：文本文件进编辑器，其他文件用系统程序打开</span>
          </div>
          <div className="tm-fpPath">
            {crumbs.map((c, i) => (
              <span key={c.path} className="crumb">
                {i > 0 && <span className="sepc">/</span>}
                <span className={`seg ${i === crumbs.length - 1 ? 'cur' : ''}`} onClick={() => void store.enter(c.path)} title={c.path}>{c.label}</span>
              </span>
            ))}
          </div>
          <FileList
            entries={s.entries}
            selected={s.selected}
            loading={s.loading}
            error={s.error}
            onSelect={p => store.select(p)}
            onOpenDir={p => void store.enter(p)}
            onOpenFile={openEntry}
            onContextMenu={(entry, e) => setCtx({ entry, x: e.clientX, y: e.clientY })}
          />
        </div>
      )}
      {picking && (
        <DirPicker
          initial={s.root}
          onCancel={() => setPicking(false)}
          onPick={(p) => { setPicking(false); void store.setRoot(p).then(() => toast(`本地根目录已切换到 ${p}`)) }}
        />
      )}
      {ctx !== null && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.entry.kind === 'dir'
            ? [{ id: 'enter', label: '进入目录' }]
            : [
                { id: 'editor', label: '在编辑器打开', disabled: ctx.entry.kind !== 'file' },
                { id: 'system', label: '用系统默认程序打开', disabled: ctx.entry.kind !== 'file' },
              ]}
          onSelect={(id) => {
            if (id === 'enter') void store.enter(ctx.entry.path)
            else if (id === 'editor') openEntry(ctx.entry, 'editor')
            else if (id === 'system') openEntry(ctx.entry, 'system')
          }}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}

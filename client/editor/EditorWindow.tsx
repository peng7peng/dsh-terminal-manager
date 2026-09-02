/**
 * F8 浮动编辑器窗 —— 拖 / 缩 / 最大化 / 最小化成底部标签；内部多 Tab；底栏操作按钮。
 * 状态在 editorStore（模块单例）；几何在 useFloatWindow（每次打开用默认，不记忆）。
 * @module dsh-terminal-manager/client/editor/EditorWindow
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { IconCheckOutline14, IconChevronDownOutline14, IconCloseFill14, IconFullscreenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { rpc } from '../rpc.ts'
import { toast } from '../toast.ts'
import { localFsStore } from '../files/FilePanel.tsx'
import { formatSize } from '../files/localFs.ts'
import { CodeEditor, type EditorHandle } from './CodeEditor.tsx'
import { EditorTabs } from './EditorTabs.tsx'
import { createEditorStore, useEditorState, type EditorStore } from './editorStore.ts'
import { useFloatWindow } from './useFloatWindow.ts'

let singleton: EditorStore | undefined
/** 模块级单例：文件面板双击 → editorStore().openFile(path)。 */
export function editorStore(): EditorStore {
  if (singleton === undefined) {
    singleton = createEditorStore({
      rpc,
      getRoot: () => localFsStore().getState().root,
      onInfo: (m) => toast(m, 'ok'),
      onError: (m) => toast(m, 'error'),
    })
  }
  return singleton
}

/** 当前激活编辑器的句柄（TC 执行 / 发送选中读选区用）。 */
let activeHandle: EditorHandle | null = null
export function getActiveEditor(): EditorHandle | null { return activeHandle }

function CloseConfirm(props: { names: string[]; onAction: (a: 'save' | 'discard' | 'cancel') => void }): React.JSX.Element {
  return (
    <div className="tm-mask" onClick={() => props.onAction('cancel')}>
      <div className="tm-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-mHead">有未保存的改动</div>
        <div className="tm-mBody">
          {props.names.map(n => <div key={n} className="tm-mRow">📄 {n}</div>)}
        </div>
        <div className="tm-mNote">关闭前保存吗？「丢弃」会丢掉这些改动。</div>
        <div className="tm-mFoot">
          <button className="tm-btnPlain" onClick={() => props.onAction('cancel')}>取消</button>
          <button className="tm-btnPlain" onClick={() => props.onAction('discard')}>丢弃</button>
          <button className="tm-btnPrimary" onClick={() => props.onAction('save')}>保存并关闭</button>
        </div>
      </div>
    </div>
  )
}

export function EditorWindow(props: {
  /** 底栏右侧的操作按钮（S3 的 TC 执行 / 发送选中由 TerminalWorkspace 注入） */
  actions?: ReactNode
  /** 编辑区右键（S3 接入右键菜单） */
  onContextMenu?: (e: React.MouseEvent) => void
  /** 底栏下方的附加区域（S3 的汇总条 / 对话框） */
  below?: ReactNode
}): React.JSX.Element | null {
  const store = editorStore()
  const s = useEditorState(store)
  const win = useFloatWindow(s.maximized)
  const handleRef = useRef<EditorHandle | null>(null)

  const active = s.tabs.find(t => t.id === s.activeId) ?? null
  useEffect(() => { activeHandle = handleRef.current; return () => { activeHandle = null } })

  if (!s.open) return null

  const dirtyCount = s.tabs.filter(t => t.dirty).length
  if (s.minimized) {
    const names = s.tabs.map(t => t.name).join('\n')
    return (
      <button
        type="button"
        className={`tm-feMinIcon ${dirtyCount > 0 ? 'dirty' : ''}`}
        onClick={() => store.restore()}
        title={`编辑器（${s.tabs.length} 个文件${dirtyCount > 0 ? `，${dirtyCount} 个未保存` : ''}）\n${names}\n点击还原`}
        aria-label="还原编辑器"
      >
        📝<span className="cnt">{s.tabs.length}</span>
      </button>
    )
  }

  const pendingNames = s.pendingClose === null ? [] : s.pendingClose === '*'
    ? s.tabs.filter(t => t.dirty).map(t => t.name)
    : s.tabs.filter(t => t.id === s.pendingClose).map(t => t.name)

  return (
    <>
      <div ref={win.rootRef} className={`tm-floatEd ${win.dragging !== null ? 'dragging' : ''}`} style={win.style} data-tm-editor>
        <div className="tm-feHead" {...win.headerHandlers} onDoubleClick={() => store.toggleMaximize()}>
          <EditorTabs tabs={s.tabs} activeId={s.activeId} onActivate={id => store.activate(id)} onClose={id => store.requestClose(id)} />
          <div className="tm-feCtrls" data-no-drag>
            <button type="button" title="最小化成底部标签" onClick={() => store.minimize()}><IconChevronDownOutline14 /></button>
            <button type="button" title={s.maximized ? '还原' : '最大化'} onClick={() => store.toggleMaximize()}><IconFullscreenOutline16 /></button>
            <button type="button" title="关闭编辑器" onClick={() => store.requestCloseWindow()}><IconCloseFill14 /></button>
          </div>
        </div>
        <div className="tm-feBody">
          {active === null ? (
            <div className="tm-feLoading">没有打开的文件</div>
          ) : active.loading ? (
            <div className="tm-feLoading">加载 {active.name} …</div>
          ) : (
            <>
              {active.truncated && <div className="tm-feBanner">文件超过 10MB，只显示前 10MB，只读。</div>}
              <CodeEditor
                key={active.id}
                ref={handleRef}
                path={active.path}
                value={active.content}
                readOnly={active.truncated}
                onChange={text => store.setContent(active.id, text)}
                onSave={() => void store.save(active.id)}
                onContextMenu={props.onContextMenu}
              />
            </>
          )}
        </div>
        <div className="tm-feFoot">
          <span className="hint" title={active?.path}>{active === null ? '' : `${active.path} · ${formatSize(active.size)}${active.truncated ? ' · 只读' : active.dirty ? ' · 未保存' : ''}`}</span>
          <button type="button" className="tm-feBtn" disabled={active === null || active.truncated || !active.dirty || active.saving} onClick={() => void store.save()} title="保存 (Ctrl/Cmd+S)"><IconCheckOutline14 /> 保存</button>
          {props.actions}
        </div>
        {props.below}
        {!s.maximized && <div className="tm-feResize" {...win.resizeHandlers} title="拖动缩放" />}
      </div>
      {s.pendingClose !== null && <CloseConfirm names={pendingNames} onAction={a => void store.confirmClose(a)} />}
    </>
  )
}

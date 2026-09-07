/**
 * F7b 远端文件面板 —— 本地面板上方的收起条。
 * chips 切换在线 SSH 会话（Telnet 不支持文件传输）；3 按钮（上传文件 / 下载=另存为 / 刷新）；
 * 面包屑 + 列表（复用 FileList）；传输进度条（transferId 关联 /term-io file-progress 帧）；
 * 同名冲突（覆盖 / 跳过 / 重命名）；OS 拖拽文件直传。另存为（GET 流式）为导航式下载。
 * 编辑器底栏的「上传到设备」入口也在这里导出（TerminalWorkspace 注入 EditorWindow actions 槽）。
 * @module dsh-terminal-manager/client/files/RemoteFilePanel
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronRightOutline14, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { rpc } from '../rpc.ts'
import { toast } from '../toast.ts'
import type { SessionSnap } from '../ConnectionsPanel.tsx'
import { ContextMenu } from '../tc/ContextMenu.tsx'
import { editorStore } from '../editor/EditorWindow.tsx'
import { useEditorState } from '../editor/editorStore.ts'
import { FileList, localFsStore } from './FilePanel.tsx'
import { baseName, breadcrumbs, type FileEntryView } from './localFs.ts'
import { createRemoteFsStore, useRemoteFsState, type RemoteFsStore, type TransferStart } from './remoteFs.ts'

let singleton: RemoteFsStore | undefined
/** 模块级单例：面板收起 / 重开不丢状态；本地侧闭包接本地面板（下载②目标 / 同名冲突检查）。 */
export function remoteFsStore(): RemoteFsStore {
  if (singleton === undefined) {
    singleton = createRemoteFsStore({
      rpc,
      localNames: () => new Set(localFsStore().getState().entries.filter(e => e.kind !== 'dir').map(e => e.name)),
      localTarget: () => {
        const s = localFsStore().getState()
        return s.ready ? { root: s.root, path: s.cwd } : undefined
      },
      localRefresh: () => { void localFsStore().refresh() },
      storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    })
  }
  return singleton
}

/** 远端面板展开后的固定高度（ Friday 交互会再定拖拽 / 样式细节）。 */
const RF_HEIGHT = 240

function toastStart(r: TransferStart, name: string, verb: '上传' | '下载'): void {
  if (r === 'started') toast(`已开始${verb} ${name}（进度见传输条）`)
  else if (r === 'blocked') toast(`无法${verb}：请先选择在线 SSH 会话`, 'error')
  // conflict：弹窗接管，不 toast
}

export function RemoteFilePanel(props: { sessions: SessionSnap[] }): React.JSX.Element {
  const store = remoteFsStore()
  const st = useRemoteFsState(store)
  const [ctx, setCtx] = useState<{ entry: FileEntryView; x: number; y: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const sshOnline = props.sessions.filter(s => s.protocol === 'ssh' && s.status === 'open')
  // 当前会话掉线 / 被断开 → 清空选择（下次连上重新选）
  useEffect(() => {
    if (st.sessionId !== null && !props.sessions.some(s => s.sessionId === st.sessionId && s.status === 'open' && s.protocol === 'ssh')) {
      void store.setSession(null)
    }
  }, [st.sessionId, props.sessions, store])

  const selectedEntry = st.entries.find(e => e.path === st.selected) ?? null
  const crumbs = st.sessionId !== null ? breadcrumbs('/', st.cwd) : []

  const saveSelectedAs = (): void => {
    if (selectedEntry === null || selectedEntry.kind !== 'file') return
    toastStart(store.saveAs(selectedEntry.path), selectedEntry.name, '下载')
  }

  return (
    <div className={`tm-fpanel ${st.expanded ? 'open' : ''}`}>
      <div className="tm-fpBar" onClick={() => store.toggleExpanded()} title={st.expanded ? '点击收起' : '点击展开'}>
        <span className="arrow"><IconChevronRightOutline14 /></span>
        <span>🖥️ 远端文件</span>
        <span className="sub">{st.sessionId === null ? '未选择会话' : st.loading ? `${st.cwd} …` : st.cwd}</span>
      </div>
      {st.expanded && (
        <div
          className="tm-fpBody"
          style={{ height: RF_HEIGHT }}
          onDragOver={e => { if (st.sessionId !== null) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
          onDrop={e => {
            e.preventDefault()
            if (st.sessionId === null) return
            const files = Array.from(e.dataTransfer.files)
            if (files.length === 0) return
            if (files.length > 1) toast('本期只支持单文件传输，已取第一个')
            toastStart(store.uploadBrowserFile(files[0]!), files[0]!.name, '上传')
          }}
        >
          <div className="tm-rfChips">
            <span className="lb">设备</span>
            {sshOnline.length === 0 && <span className="none">请先连接 SSH 设备（Telnet 不支持文件传输）</span>}
            {sshOnline.map(s => (
              <span key={s.sessionId} className={`tm-rchip ${st.sessionId === s.sessionId ? 'on' : ''}`} onClick={() => void store.setSession(s.sessionId)}>{s.label}</span>
            ))}
          </div>
          <div className="tm-fpToolbar">
            <button className="tm-tbtn" disabled={st.sessionId === null} onClick={() => fileInputRef.current?.click()} title="上传本机文件到远端当前目录（也可拖文件进来）">⬆ 上传文件</button>
            <button className="tm-tbtn" disabled={selectedEntry === null || selectedEntry.kind !== 'file'} onClick={saveSelectedAs} title="另存为到本机（浏览器选择保存位置）">⬇ 下载</button>
            <button className="tm-tbtn icon" disabled={st.sessionId === null} onClick={() => { void store.refresh(); toast('远端列表已刷新') }} title="刷新" aria-label="刷新"><IconRefreshOutline14 /></button>
          </div>
          {st.sessionId !== null && (
            <div className="tm-fpPath">
              {crumbs.map((c, i) => (
                <span key={c.path} className="crumb">
                  {i > 0 && <span className="sepc">/</span>}
                  <span className={`seg ${i === crumbs.length - 1 ? 'cur' : ''}`} onClick={() => void store.enter(c.path)} title={c.path}>{c.label}</span>
                </span>
              ))}
            </div>
          )}
          {st.sessionId === null ? (
            <div className="tm-fpEmpty">请先连接 SSH 设备，并在上方选择会话</div>
          ) : (
            <FileList
              entries={st.entries}
              selected={st.selected}
              loading={st.loading}
              error={st.error}
              onSelect={p => store.select(p)}
              onOpenDir={p => void store.enter(p)}
              onOpenFile={entry => { if (entry.kind === 'file') toastStart(store.saveAs(entry.path), entry.name, '下载') }}
              onContextMenu={(entry, e) => setCtx({ entry, x: e.clientX, y: e.clientY })}
            />
          )}
          {st.transfers.length > 0 && (
            <div className="tm-fpXfers">
              <div className="tm-fpXferHead">
                <span>传输（{st.transfers.length}）</span>
                {st.transfers.some(t => t.done) && <button className="tm-tbtn" onClick={() => store.clearFinished()}>清除已完成</button>}
              </div>
              {st.transfers.map(t => (
                <div
                  key={t.transferId}
                  className={`tm-fpXfer ${t.done === true ? (t.ok === true ? 'ok' : 'fail') : ''}`}
                  title={t.error ?? `${t.op === 'upload' ? '上传到' : '下载自'} ${t.remotePath}${t.localPath !== undefined ? `\n→ ${t.localPath}` : ''}`}
                >
                  <span className="ico">{t.op === 'upload' ? '⬆' : '⬇'}</span>
                  <span className="nm">{t.name}</span>
                  <span className="bar"><span style={{ width: `${t.done ? 100 : (t.percent ?? 0)}%` }} /></span>
                  <span className="pct">{t.done ? (t.ok === true ? '✓' : '✗') : t.percent !== undefined ? `${t.percent}%` : '…'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {st.conflict !== null && (
        <div className="tm-mask" onClick={() => store.resolveConflict('skip')}>
          <div className="tm-modal" onClick={e => e.stopPropagation()}>
            <div className="tm-mHead">同名文件</div>
            <div className="tm-mBody">
              <div className="tm-mRow">
                {st.conflict.op === 'upload' ? '远端当前目录' : '本地当前目录'}已有「{st.conflict.name}」。
              </div>
            </div>
            <div className="tm-mNote">覆盖 = 替换原文件；跳过 = 不传这个文件；重命名 = 自动换名（如「a (1).txt」）。</div>
            <div className="tm-mFoot">
              <button className="tm-btnPlain" onClick={() => store.resolveConflict('skip')}>跳过</button>
              <button className="tm-btnPlain" onClick={() => store.resolveConflict('rename')}>重命名</button>
              <button className="tm-btnPrimary" onClick={() => store.resolveConflict('overwrite')}>覆盖</button>
            </div>
          </div>
        </div>
      )}
      {ctx !== null && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.entry.kind === 'dir'
            ? [{ id: 'enter', label: '进入目录' }]
            : [
                { id: 'saveas', label: '另存为到本机…' },
                { id: 'tolocal', label: '下载到工作区（本地面板当前目录）' },
              ]}
          onSelect={(id) => {
            if (id === 'enter') void store.enter(ctx.entry.path)
            else if (id === 'saveas') toastStart(store.saveAs(ctx.entry.path), ctx.entry.name, '下载')
            else if (id === 'tolocal') toastStart(store.downloadToWorkspace(ctx.entry.path), ctx.entry.name, '下载')
          }}
          onClose={() => setCtx(null)}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={() => {
          const input = fileInputRef.current
          if (input === null) return
          const file = input.files?.[0]
          input.value = ''
          if (file === undefined) return
          toastStart(store.uploadBrowserFile(file), file.name, '上传')
        }}
      />
    </div>
  )
}

/** 编辑器底栏「上传到设备」：把当前打开的文件（本地面板树根内）传到远端当前目录。 */
export function EditorUploadButton(): React.JSX.Element {
  const remote = useRemoteFsState(remoteFsStore())
  const editor = useEditorState(editorStore())
  const active = editor.tabs.find(t => t.id === editor.activeId) ?? null
  const disabled = active === null || remote.sessionId === null
  return (
    <button
      type="button"
      className="tm-feBtn"
      disabled={disabled}
      title={disabled ? '需要：编辑器有打开的文件，且远端面板已选择在线 SSH 会话' : `上传到远端当前目录 ${remote.cwd}`}
      onClick={() => {
        if (active === null) return
        const name = baseName(active.path)
        const local = localFsStore().getState()
        const r = remoteFsStore().uploadLocalFile({ root: local.root, path: active.path, name, size: active.size })
        if (r === 'started') toast(active.dirty ? `已开始上传 ${name}（有未保存改动，上传的是已保存版本）` : `已开始上传 ${name}（进度见传输条）`)
        else if (r === 'blocked') toast('无法上传：请先在远端面板选择在线 SSH 会话', 'error')
      }}
    >⬆ 上传到设备</button>
  )
}

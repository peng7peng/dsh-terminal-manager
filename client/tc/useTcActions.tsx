/**
 * F10/F11 编辑器底栏动作 + 右键菜单 + 三个对话框 + 汇总条的组装。
 * TerminalWorkspace 只调 useTcActions(sessions)，把返回的 actions / below / onContextMenu 交给 EditorWindow。
 *
 * 流程 A（执行脚本 / 执行选中 / 执行本节）：解析 → 冻结映射快照 → 确认框（可「本次会话不再确认」）→ 逐条 sessions.send → 汇总条。
 * 流程 B（发送选中）：选区按行 → 终端多选 → 逐条 sessions.send → 同一汇总条。
 * @module dsh-terminal-manager/client/tc/useTcActions
 */

import { useState, type ReactNode } from 'react'
import { IconDownloadOutline16, IconPlayOutline16, IconSendOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { delayHints, parseTcScript, resolveTargetsAt, sectionRange, type TcLine } from '../../src/tc-parser.ts'
import { editorStore, getActiveEditor } from '../editor/EditorWindow.tsx'
import { extOf, useEditorState } from '../editor/editorStore.ts'
import { rpc } from '../rpc.ts'
import { toast } from '../toast.ts'
import { ContextMenu, type CtxItem } from './ContextMenu.tsx'
import { pickSendTargets, planRun, runPlan, summarize, type RunItem } from './runScript.ts'
import { buildTcOrder, tcIndexMap, tcTargetMap, type TcSession } from './tcMap.ts'
import { SendSelectionDialog, TcConfirmDialog, TcTimeoutDialog } from './TcDialogs.tsx'
import { TcSummaryBar } from './TcSummaryBar.tsx'
import { getSendSkipConfirm, getSkipConfirm, getTcRun, patchTcRun, setSendSkipConfirm, setSkipConfirm, setTcRun, useTcRun } from './tcRunStore.ts'

/** 按钮可用性矩阵（D5） */
export function abilitiesFor(ext: string): { run: boolean; send: boolean } {
  return { run: ext === 'txt', send: ext === 'txt' || ext === 'md' }
}

function flashPane(sessionId: string): void {
  if (typeof document === 'undefined') return
  const pane = document.querySelector(`[data-session-id="${sessionId}"] .tm-pane`)
  if (pane === null) return
  pane.classList.add('tm-focus-flash')
  setTimeout(() => pane.classList.remove('tm-focus-flash'), 1200)
}

interface ConfirmState { title: string; items: RunItem[]; hints: Array<{ lineNo: number; text: string }> }
interface TimeoutAsk { item: RunItem; resolve: (d: 'continue' | 'abort') => void }

export function useTcActions(sessions: readonly TcSession[], bcTargets: readonly string[]): { actions: ReactNode; below: ReactNode; onContextMenu: (e: React.MouseEvent) => void } {
  const ed = useEditorState(editorStore())
  const run = useTcRun()
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [timeoutAsk, setTimeoutAsk] = useState<TimeoutAsk | null>(null)
  const [sendDlg, setSendDlg] = useState<{ lines: string[]; defaultIds: string[] } | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)

  const active = ed.tabs.find(t => t.id === ed.activeId) ?? null
  const ext = active === null ? '' : extOf(active.path)
  const can = abilitiesFor(ext)
  const running = run?.running === true
  const tcMap = tcIndexMap(buildTcOrder(sessions))

  async function execute(title: string, items: RunItem[]): Promise<void> {
    if (getTcRun()?.running) { toast('已有脚本在执行，请先等待完成或中止', 'error'); return }
    const ac = new AbortController()
    setTcRun({ title, items, running: true, startedAt: Date.now(), abort: () => ac.abort() })
    const result = await runPlan(items, {
      send: (sid, cmd) => rpc<{ waitReason: string; output: string }>('sessions.send', { sessionId: sid, command: cmd, source: 'script' }),
      onUpdate: (its) => {
        patchTcRun({ items: its })
        for (const it of its) if (it.status === 'running' && it.sessionId !== undefined) flashPane(it.sessionId)
      },
      onTimeout: (item) => new Promise(resolve => setTimeoutAsk({ item, resolve })),
      signal: ac.signal,
    })
    setTimeoutAsk(null)
    patchTcRun({ items: result, running: false, finishedAt: Date.now() })
    const s = summarize(result)
    const bad = s.timeout + s.error + s.noTarget
    toast(`${title}：成功 ${s.ok}${bad > 0 ? ` / 失败 ${bad}` : ''}${s.aborted > 0 ? ` / 中止 ${s.aborted}` : ''}`, bad > 0 || s.aborted > 0 ? 'error' : 'ok')
  }

  /** 流程 A 入口：mode = 整文件 / 选中 / 本节 */
  function prepareRun(mode: 'all' | 'selection' | 'section'): void {
    const h = getActiveEditor()
    if (h === null || active === null) { toast('没有打开的文件'); return }
    if (!can.run) { toast('仅 TC 脚本（.txt）可执行'); return }
    const all = parseTcScript(h.getText())
    let lines: TcLine[]
    let title: string
    if (mode === 'all') {
      lines = all
      title = `执行 ${active.name}`
    } else if (mode === 'selection') {
      const sel = h.getSelection()
      if (sel === null) { toast('请先在编辑器里选中要执行的行'); return }
      lines = parseTcScript(sel.text, { initialTargets: resolveTargetsAt(all, sel.fromLine), lineOffset: sel.fromLine - 1 })
      title = `执行 ${active.name} 第 ${sel.fromLine}–${sel.toLine} 行`
    } else {
      const range = sectionRange(all, h.getCursorLine())
      if (range === undefined) { toast('光标所在位置没有节') ; return }
      lines = all.filter(l => l.lineNo >= range.start && l.lineNo <= range.end)
      title = `执行 ${active.name} [${range.section ?? '无标题'}]`
    }
    const targets = tcTargetMap(sessions)
    if (targets.size === 0) { toast('没有在线终端，无法执行', 'error'); return }
    const items = planRun(lines, targets)
    if (items.length === 0) { toast('脚本无可执行命令'); return }
    const hints = delayHints(lines)
    if (getSkipConfirm()) void execute(title, items)
    else setConfirm({ title, items, hints })
  }

  /** 流程 B 入口（按钮和右键都走这里）：勾过「不再提示」就直接按广播栏所选发送，不弹框 */
  function prepareSend(): void {
    const h = getActiveEditor()
    if (h === null || active === null) { toast('没有打开的文件'); return }
    if (!can.send) { toast('仅 .md / .txt 支持发送选中'); return }
    const sel = h.getSelection()
    if (sel === null) { toast('请先在编辑器里选中要发送的内容'); return }
    const lines = sel.text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0)
    if (lines.length === 0) { toast('选中内容为空'); return }
    const onlineIds = sessions.filter(s => s.status === 'open').map(s => s.sessionId)
    if (onlineIds.length === 0) { toast('没有在线终端', 'error'); return }
    // 默认目标跟随广播栏当前所选（语义与广播一致：没勾就发第一台，避免误发全部）
    const defaultIds = pickSendTargets(bcTargets, onlineIds)
    if (getSendSkipConfirm()) { void runSend(lines, defaultIds); return }
    setSendDlg({ lines, defaultIds })
  }

  function runSend(lines: string[], sessionIds: string[]): void {
    if (active === null) return
    const items: RunItem[] = []
    lines.forEach((command, i) => {
      for (const sid of sessionIds) {
        const s = sessions.find(x => x.sessionId === sid)
        const tc = tcMap.get(sid)
        // 弹窗只列在线会话，理论上都在映射里；万一在勾选与发送之间掉线，就标成无对应终端而不是发出去
        items.push(tc === undefined
          ? { key: `${i + 1}:${sid}`, lineNo: i + 1, command, tc: 0, label: s?.label ?? sid, status: 'no-target' }
          : { key: `${i + 1}:${sid}`, lineNo: i + 1, command, tc, sessionId: sid, label: s?.label ?? sid, status: 'pending' })
      }
    })
    void execute(`发送选中（${active.name}，${lines.length} 行 → ${sessionIds.length} 个终端）`, items)
  }

  function doSend(sessionIds: string[], skip: boolean): void {
    const dlg = sendDlg
    setSendDlg(null)
    setSendSkipConfirm(skip)
    if (dlg === null) return
    void runSend(dlg.lines, sessionIds)
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    if (active === null) return
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, hasSelection: getActiveEditor()?.getSelection() !== null })
  }
  const ctxItems: CtxItem[] = ctx === null ? [] : [
    { id: 'run-sel', label: '▶ 执行选中脚本', kind: 'go', disabled: !can.run || !ctx.hasSelection || running, title: can.run ? undefined : '仅 TC 脚本(.txt)可执行' },
    { id: 'run-sec', label: '▶ 执行本节（到下一个 [标题] 前）', kind: 'go', disabled: !can.run || running, title: can.run ? undefined : '仅 TC 脚本(.txt)可执行' },
    { id: 'send-sel', label: '发送选中到终端…', kind: 'send', disabled: !can.send || !ctx.hasSelection || running, title: can.send ? undefined : '仅 .md/.txt 支持发送选中' },
    { id: 'sep', label: '', kind: 'sep' },
    { id: 'copy', label: '复制', disabled: !ctx.hasSelection },
  ]
  const onCtxSelect = (id: string): void => {
    if (id === 'run-sel') prepareRun('selection')
    else if (id === 'run-sec') prepareRun('section')
    else if (id === 'send-sel') prepareSend()
    else if (id === 'copy') {
      const sel = getActiveEditor()?.getSelection()
      if (sel !== null && sel !== undefined) void navigator.clipboard?.writeText(sel.text).then(() => toast('已复制'))
    }
  }

  const actions = (
    <>
      <button type="button" className="tm-feBtn" disabled title="上传到设备：随文件传输（S5）交付"><IconDownloadOutline16 /> 上传</button>
      <button type="button" className="tm-feBtn send" disabled={active === null || !can.send || running} title={can.send ? '把选中的行逐条发到勾选的终端' : '仅 .md/.txt 支持发送选中'} onClick={prepareSend}><IconSendOutline14 /> 发送选中 →</button>
      <button type="button" className="tm-feBtn go" disabled={active === null || !can.run || running} title={can.run ? '按脚本里的 ##>N 映射逐条发送（不用选终端）' : '仅 TC 脚本(.txt)可执行'} onClick={() => prepareRun('all')}><IconPlayOutline16 /> 执行脚本</button>
    </>
  )

  const below = (
    <>
      <TcSummaryBar />
      {confirm !== null && (
        <TcConfirmDialog
          title={confirm.title}
          items={confirm.items}
          hints={confirm.hints}
          onCancel={() => setConfirm(null)}
          onConfirm={(skip) => { setSkipConfirm(skip); const c = confirm; setConfirm(null); void execute(c.title, c.items) }}
        />
      )}
      {timeoutAsk !== null && <TcTimeoutDialog item={timeoutAsk.item} onDecide={(d) => { const t = timeoutAsk; setTimeoutAsk(null); t.resolve(d) }} />}
      {sendDlg !== null && <SendSelectionDialog sessions={[...sessions]} tcMap={tcMap} lines={sendDlg.lines} defaultPicked={sendDlg.defaultIds} onCancel={() => setSendDlg(null)} onConfirm={doSend} />}
      {ctx !== null && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onSelect={onCtxSelect} onClose={() => setCtx(null)} />}
    </>
  )

  return { actions, below, onContextMenu }
}

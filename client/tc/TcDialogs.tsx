/**
 * F10/F11 三个对话框：TC 映射确认（D8）、超时决策、发送选中的终端多选。
 * @module dsh-terminal-manager/client/tc/TcDialogs
 */

import { useState } from 'react'
import { IconPlayOutline16, IconSendOutline14, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tcUsage, type RunItem } from './runScript.ts'
import type { TcSession } from './tcMap.ts'

export function TcConfirmDialog(props: {
  title: string
  items: RunItem[]
  hints: Array<{ lineNo: number; text: string }>
  onConfirm: (skipNext: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const [skip, setSkip] = useState(false)
  const usage = tcUsage(props.items)
  const runnable = props.items.filter(i => i.status === 'pending').length
  return (
    <div className="tm-mask" onClick={props.onCancel}>
      <div className="tm-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-mHead"><IconPlayOutline16 /> 执行脚本 — 确认 TC 编号映射</div>
        <div className="tm-mBody">
          <div className="tm-mNote" style={{ padding: '0 8px 4px' }}>{props.title}：共 {props.items.length} 条发送</div>
          {usage.map(u => (
            <div key={u.tc} className="tm-mRow">
              <span className="tm-tcn">TC{u.tc}</span>
              {u.target !== undefined
                ? <><span>{u.target.label}</span><span className="sub">{u.count} 条</span></>
                : <><span>—</span><span className="miss">✗ 无对应在线终端（{u.count} 条将跳过）</span></>}
            </div>
          ))}
          {props.hints.length > 0 && (
            <div className="tm-mNote warn" style={{ padding: '6px 8px 0' }}>
              <IconWarningOutline16 /> 脚本里有 {props.hints.length} 处「间隔再发」提示，本次不会自动等待：
              {props.hints.map(h => <div key={h.lineNo}>第 {h.lineNo} 行：{h.text}</div>)}
            </div>
          )}
        </div>
        <div className="tm-mNote">映射 = 活跃会话列表顺序（拖动列表即切换编号）；执行期间映射冻结。</div>
        <div className="tm-mFoot">
          <label><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} /> 本次会话不再确认</label>
          <span className="sp" />
          <button className="tm-btnPlain" onClick={props.onCancel}>取消</button>
          <button className="tm-btnGo" disabled={runnable === 0} onClick={() => props.onConfirm(skip)}>▶ 确认执行（{runnable}）</button>
        </div>
      </div>
    </div>
  )
}

export function TcTimeoutDialog(props: { item: RunItem; onDecide: (d: 'continue' | 'abort') => void }): React.JSX.Element {
  return (
    <div className="tm-mask">
      <div className="tm-modal">
        <div className="tm-mHead"><IconWarningOutline16 /> 命令超时</div>
        <div className="tm-mBody">
          <div className="tm-mRow"><span className="tm-tcn">TC{props.item.tc}</span><span>{props.item.label}</span></div>
          <div className="tm-mRow"><code>{props.item.command}</code></div>
          <div className="tm-mNote" style={{ padding: '4px 8px 0' }}>等待完成判定超时（未见提示符也无静默）。可以先看终端窗格里的输出再决定。</div>
        </div>
        <div className="tm-mFoot">
          <button className="tm-btnPlain" onClick={() => props.onDecide('abort')}>中止剩余</button>
          <button className="tm-btnPrimary" onClick={() => props.onDecide('continue')}>跳过，继续下一条</button>
        </div>
      </div>
    </div>
  )
}

export function SendSelectionDialog(props: {
  sessions: TcSession[]
  tcMap: ReadonlyMap<string, number>
  lines: string[]
  /** 默认勾选（跟随广播栏当前所选；与在线会话的交集） */
  defaultPicked: string[]
  onConfirm: (sessionIds: string[], skipNext: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const online = props.sessions.filter(s => s.status === 'open')
  const [picked, setPicked] = useState<Set<string>>(() => {
    const def = props.defaultPicked.filter(id => online.some(s => s.sessionId === id))
    return new Set(def.length > 0 ? def : online.slice(0, 1).map(s => s.sessionId))
  })
  const [skip, setSkip] = useState(false)
  const toggle = (sid: string): void => setPicked(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n })
  const many = props.lines.length > 20
  return (
    <div className="tm-mask" onClick={props.onCancel}>
      <div className="tm-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-mHead"><IconSendOutline14 /> 发送选中内容到终端</div>
        <div className="tm-mBody">
          {online.length === 0 && <div className="tm-fpEmpty">没有在线终端</div>}
          {online.map(s => (
            <label key={s.sessionId} className="tm-mRow click">
              <input type="checkbox" checked={picked.has(s.sessionId)} onChange={() => toggle(s.sessionId)} />
              <span className="tm-tcn ghost">TC{props.tcMap.get(s.sessionId)}</span>
              <span>{s.label}</span>
            </label>
          ))}
        </div>
        <div className={`tm-mNote ${many ? 'warn' : ''}`}>
          {many
            ? `⚠ 选中 ${props.lines.length} 行，逐条发送预计约 ${Math.ceil(props.lines.length * 0.6)} 秒（每条等静默 500ms+），确认继续？`
            : `逐条发送 ${props.lines.length} 行：每条等回显 / 静默后再发下一条；超时可跳过。`}
        </div>
        {skip && (
          <div className="tm-mNote warn" style={{ padding: '4px 8px 0' }}>
            勾选「不再提示」后：广播栏<b>勾选了终端</b>时，点「发送选中 →」和右键都<b>直接发送</b>给广播栏所选（掉线的不发）；广播栏<b>没勾选</b>时仍会弹框，不会盲发。重新打开工作区后恢复弹框。
          </div>
        )}
        <div className="tm-mFoot">
          <label title="下次广播栏勾选了终端时，「发送选中 →」和右键都直接发给广播栏所选，不再弹框；广播栏没勾选时仍会弹框。重新打开工作区后恢复">
            <input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} /> 不再提示
          </label>
          <span className="sp" />
          <button className="tm-btnPlain" onClick={props.onCancel}>取消</button>
          <button className="tm-btnPrimary" disabled={picked.size === 0} onClick={() => props.onConfirm([...picked], skip)}>发送（{picked.size}）</button>
        </div>
      </div>
    </div>
  )
}

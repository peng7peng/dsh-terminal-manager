/**
 * F1+F3 工作区覆盖层 —— 终端区 + 广播栏 + 连接面板。
 * 挂在 shell.overlay 插槽；由侧边栏按钮切换可见性。
 * @module dsh-terminal-manager/client/TerminalWorkspace
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { rpc, type RpcError } from './rpc.ts'
import { TermWs } from './ws.ts'
import { setWorkspaceVisible, useSidebarWidth, useWorkspaceVisible } from './store.ts'
import { ConnectionsPanel, type ConnectionCfg, type SessionSnap } from './ConnectionsPanel.tsx'
import { TermView } from './TermView.tsx'

export function TerminalWorkspace(): React.JSX.Element | null {
  const visible = useWorkspaceVisible()
  const sidebarWidth = useSidebarWidth()
  const wsRef = useRef<TermWs | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionSnap[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [broadcastChips, setBroadcastChips] = useState<Set<string>>(new Set())
  const [bcCmd, setBcCmd] = useState('')

  // 初始化 WS（仅一次）
  if (wsRef.current === undefined && visible) {
    const ws = new TermWs()
    ws.onStatus(frame => {
      setSessions(prev => {
        const snap = frame as unknown as SessionSnap
        const i = prev.findIndex(s => s.sessionId === snap.sessionId)
        if (snap.status === 'closed') return i >= 0 ? prev.filter(s => s.sessionId !== snap.sessionId) : prev
        return i >= 0 ? prev.map(s => s.sessionId === snap.sessionId ? snap : s) : [...prev, snap]
      })
    })
    ws.open()
    wsRef.current = ws
  }

  // 首次可见时拉一次会话全量快照
  useEffect(() => {
    if (!visible) return
    void (async () => {
      try { setSessions(await rpc<SessionSnap[]>('sessions.list')) } catch { /* ignore */ }
    })()
  }, [visible])

  // 卸载或不可见时关 WS
  useEffect(() => {
    if (visible) return
    const ws = wsRef.current
    if (ws !== undefined) { ws.dispose(); wsRef.current = undefined }
  }, [visible])

  useEffect(() => () => wsRef.current?.dispose(), [])

  const ws = wsRef.current

  async function connect(connId: string): Promise<void> {
    try { await rpc('sessions.connect', { connId }) } catch (err) { alert((err as RpcError).message) }
  }
  async function disconnect(sessionId: string): Promise<void> {
    try { await rpc('sessions.disconnect', { sessionId }) } catch { /* ignore */ }
  }

  const visibleSessions = useMemo(
    () => sessions.filter(s => s.status === 'open' && !hidden.has(s.sessionId)),
    [sessions, hidden],
  )

  // 广播目标默认全选可见会话
  const allOn = visibleSessions.length > 0 && visibleSessions.every(s => broadcastChips.has(s.sessionId))
  function toggleChip(sid: string): void {
    setBroadcastChips(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n })
  }
  function toggleAll(): void {
    setBroadcastChips(allOn ? new Set() : new Set(visibleSessions.map(s => s.sessionId)))
  }
  function broadcast(): void {
    if (bcCmd.trim() === '' || ws === undefined) return
    const targets = broadcastChips.size > 0 ? [...broadcastChips] : visibleSessions.map(s => s.sessionId)
    for (const sid of targets) ws.input(sid, bcCmd + '\r')
    setBcCmd('')
  }

  if (!visible || ws === undefined) return null

  const onlineCount = sessions.filter(s => s.status === 'open').length
  const allCount = sessions.length

  return (
    <div className="tm-overlay" style={{ left: `${sidebarWidth}px` }}>
      <div className="tm-main">
        <div className="tm-head">
          <span className="t">🖥️ 终端</span>
          <span className="onb">在线 <b>{onlineCount}</b> / {allCount}</span>
          <span className="sp" />
          <button className="tm-close" onClick={() => setHidden(h => { const n = new Set(h); visibleSessions.forEach(s => n.add(s.sessionId)); return n })}>全部隐藏</button>
          <button className="tm-close" onClick={() => setHidden(new Set())}>全部显示</button>
          <button className="tm-close" onClick={() => setWorkspaceVisible(false)}>✕ 关闭</button>
        </div>
        <div className="tm-grid">
          {visibleSessions.length === 0 ? (
            <div className="tm-empty">暂无已连接会话 —— 右侧连接设备</div>
          ) : visibleSessions.map(s => (
            <TermView key={s.sessionId} sessionId={s.sessionId} label={s.label} target={s.target} ws={ws} onDisconnect={disconnect} />
          ))}
        </div>
        <div className="tm-bcast">
          <span className="lb">📢 广播到</span>
          <div className="tm-bchips">
            <span className={`tm-bchip ${allOn ? 'on' : ''}`} onClick={toggleAll}>全部</span>
            {visibleSessions.map(s => (
              <span key={s.sessionId} className={`tm-bchip ${broadcastChips.has(s.sessionId) ? 'on' : ''}`} onClick={() => toggleChip(s.sessionId)}>{s.label}</span>
            ))}
          </div>
          <input value={bcCmd} onChange={e => setBcCmd(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') broadcast() }} placeholder="命令…" />
          <button className="tm-bsend" onClick={broadcast}>{broadcastChips.size > 0 ? `发送（${broadcastChips.size}）` : '发送'}</button>
        </div>
      </div>
      <ConnectionsPanel sessions={sessions} onConnect={connect} onDisconnect={disconnect} />
    </div>
  )
}

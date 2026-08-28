/**
 * F1+F3 工作区覆盖层 —— 终端区 + 广播栏 + 连接面板。
 * 挂在 shell.overlay 插槽；由侧边栏按钮切换可见性。
 * @module dsh-terminal-manager/client/TerminalWorkspace
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { rpc, type RpcError } from './rpc.ts'
import { TermWs } from './ws.ts'
import { setChatWidth, setWorkspaceVisible, useChatWidth, useFrameLayout, useUnread, useWorkspaceVisible } from './store.ts'
import { markRead, markUnread } from './store.ts'
import { ConnectionsPanel, type ConnectionCfg, type SessionSnap } from './ConnectionsPanel.tsx'
import { TermView } from './TermView.tsx'

export function TerminalWorkspace(): React.JSX.Element | null {
  const visible = useWorkspaceVisible()
  const chat = useChatWidth()
  const termLeft = useFrameLayout(visible, chat)
  const unreadSet = useUnread()

  // 拖动条：拖左→聊天变窄/终端变宽；拖右→聊天变宽/终端变窄
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startChat = chat
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => setChatWidth(startChat + (ev.clientX - startX))
    const up = (): void => {
      handle.releasePointerCapture(e.pointerId)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }
  const wsRef = useRef<TermWs | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionSnap[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [sessionOrder, setSessionOrder] = useState<string[]>([])
  const [broadcastChips, setBroadcastChips] = useState<Set<string>>(new Set())
  const [bcCmd, setBcCmd] = useState('')
  const [columns, setColumns] = useState<1 | 2 | 3>(2) // 默认 2 列
  const [maximized, setMaximized] = useState<string | null>(null) // 最大化的会话 ID

  function toggleHidden(sid: string): void {
    setHidden(prev => {
      const n = new Set(prev)
      if (n.has(sid)) { n.delete(sid); markRead(sid) } else { n.add(sid) }
      return n
    })
  }
  function reorder(newOrder: string[]): void { setSessionOrder(newOrder) }
  function toggleMaximize(sid: string): void {
    setMaximized(prev => prev === sid ? null : sid)
  }
  function minimize(sid: string): void {
    setHidden(prev => {
      const n = new Set(prev)
      n.add(sid)
      return n
    })
    setMaximized(null)
  }

  // 初始化 WS（仅一次）
  if (wsRef.current === undefined && visible) {
    const ws = new TermWs()
    ws.onStatus(frame => {
      setSessions(prev => {
        const snap = frame as unknown as SessionSnap
        // connecting 跳过（避免连接失败时幽灵条目）
        if (snap.status === 'connecting') return prev
        // removed：用户主动断开，从列表移除
        if (snap.status === 'removed') {
          return prev.filter(s => s.sessionId !== snap.sessionId)
        }
        // open/closed 都保留在列表里（closed 标记为已断开，可重连）
        const i = prev.findIndex(s => s.sessionId === snap.sessionId)
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

  async function connect(target: { connId?: string; protocol?: string; host?: string; port?: number; username?: string; password?: string; label?: string }): Promise<void> {
    try {
      const snap = await rpc<SessionSnap>('sessions.connect', target)
      setSessions(prev => prev.some(s => s.sessionId === snap.sessionId) ? prev.map(s => s.sessionId === snap.sessionId ? snap : s) : [...prev, snap])
    } catch (err) { alert((err as RpcError).message) }
  }
  async function disconnect(sessionId: string): Promise<void> {
    try { await rpc('sessions.disconnect', { sessionId }) } catch { /* ignore */ }
  }
  async function reconnect(sessionId: string): Promise<void> {
    try {
      const snap = await rpc<SessionSnap>('sessions.reconnect', { sessionId })
      setSessions(prev => prev.map(s => s.sessionId === snap.sessionId ? snap : s))
    } catch (err) {
      console.error('Reconnect failed:', err)
      alert((err as RpcError).message)
    }
  }

  const allSessions = useMemo(
    () => {
      return [...sessions].sort((a, b) => {
        const ai = sessionOrder.indexOf(a.sessionId); const bi = sessionOrder.indexOf(b.sessionId)
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      })
    },
    [sessions, sessionOrder],
  )

  // 广播目标默认全选可见的「在线」会话
  const visibleSessions = allSessions.filter(s => s.status === 'open' && !hidden.has(s.sessionId))
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
    <div className="tm-overlay" style={{ left: `${termLeft}px`, right: '0px' }}>
      <div className="tm-draghandle" onPointerDown={onDragStart} title="拖动调整聊天/终端宽度" />
      <div className="tm-main">
        <div className="tm-head">
          <span className="t">🖥️ 终端</span>
          <span className="onb">在线 <b>{onlineCount}</b> / {allCount}</span>
          <span className="sp" />
          <label className="tm-col-select">
            <span>列数</span>
            <select value={columns} onChange={e => setColumns(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>1 列</option>
              <option value={2}>2 列</option>
              <option value={3}>3 列</option>
            </select>
          </label>
          <button className="tm-close" onClick={() => setHidden(h => { const n = new Set(h); visibleSessions.forEach(s => n.add(s.sessionId)); return n })}>全部隐藏</button>
          <button className="tm-close" onClick={() => setHidden(new Set())}>全部显示</button>
        </div>
        <div className="tm-grid" style={{ gridTemplateColumns: maximized ? '1fr' : `repeat(${columns}, 1fr)` }}>
          {allSessions.length === 0 ? (
            <div className="tm-empty">暂无已连接会话 —— 右侧连接设备</div>
          ) : allSessions.map(s => {
            // 最大化时只显示被最大化的那个
            if (maximized !== null && s.sessionId !== maximized) return null
            return (
              <div key={s.sessionId} className={`${hidden.has(s.sessionId) ? 'tm-term-hidden' : ''} ${s.status === 'closed' ? 'tm-term-closed' : ''} ${maximized === s.sessionId ? 'tm-term-maximized' : ''}`}>
                <TermView
                  sessionId={s.sessionId}
                  label={s.label}
                  target={s.target}
                  ws={ws}
                  onDisconnect={disconnect}
                  onReconnect={reconnect}
                  isHidden={hidden.has(s.sessionId)}
                  isClosed={s.status === 'closed'}
                  isMaximized={maximized === s.sessionId}
                  onToggleMaximize={() => toggleMaximize(s.sessionId)}
                  onMinimize={() => minimize(s.sessionId)}
                />
              </div>
            )
          })}
        </div>
        <div className="tm-bcast">
          <div className="tm-brow">
            <span className="lb">📢 广播到</span>
            <div className="tm-bchips">
              <span className={`tm-bchip ${allOn ? 'on' : ''}`} onClick={toggleAll}>全部</span>
              {visibleSessions.map(s => (
                <span key={s.sessionId} className={`tm-bchip ${broadcastChips.has(s.sessionId) ? 'on' : ''}`} onClick={() => toggleChip(s.sessionId)}>{s.label}</span>
              ))}
            </div>
          </div>
          <div className="tm-brow">
            <input value={bcCmd} onChange={e => setBcCmd(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') broadcast() }} placeholder="输入要广播到所选会话的命令…" />
            <button className="tm-bsend" onClick={broadcast}>{broadcastChips.size > 0 ? `发送（${broadcastChips.size}）` : '发送'}</button>
          </div>
        </div>
      </div>
      <ConnectionsPanel sessions={sessions} unreadSet={unreadSet} hiddenSet={hidden} sessionOrder={sessionOrder} onConnect={connect} onDisconnect={disconnect} onReconnect={reconnect} onMarkRead={markRead} onToggleHidden={toggleHidden} onReorder={reorder} />
    </div>
  )
}

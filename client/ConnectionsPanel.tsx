/**
 * F2 连接面板 —— 第一批升级修订版。
 * 密码切换(文字) + 端口加宽 + 收藏栏(折叠) + 最近连接右键菜单 + 会话右键(显示/隐藏+断开) + 拖动排序
 * @module dsh-terminal-manager/client/ConnectionsPanel
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { rpc, type RpcError } from './rpc.ts'

/** 可折叠分区 */
function CollapsibleSection({ title, count, children }: { title: string; count: number; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      <div className="tm-secLabel" style={{ marginTop: 12, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => setOpen(v => !v)}>
        <span style={{ fontSize: 10, transition: 'transform .2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
        {title} {count > 0 ? `(${count})` : ''}
      </div>
      <div style={{ display: open ? 'block' : 'none' }}>{children}</div>
    </>
  )
}

export interface ConnectionCfg { id: string; label: string; protocol: 'ssh' | 'telnet'; host: string; port: number; username?: string; note?: string }
export interface SessionSnap { sessionId: string; connId?: string; label: string; target: string; protocol: 'ssh' | 'telnet'; status: 'connecting' | 'open' | 'closed' }
export interface ConnectTarget { connId?: string; protocol?: 'ssh' | 'telnet'; host?: string; port?: number; username?: string; password?: string; label?: string }

interface Props {
  sessions: SessionSnap[]
  unreadSet: Set<string>
  hiddenSet: Set<string>
  sessionOrder: string[]
  onConnect: (target: ConnectTarget) => void
  onDisconnect: (sessionId: string) => void
  onMarkRead: (sessionId: string) => void
  onToggleHidden: (sessionId: string) => void
  onReorder: (newOrder: string[]) => void
}

export function ConnectionsPanel({ sessions, unreadSet, hiddenSet, sessionOrder, onConnect, onDisconnect, onMarkRead, onToggleHidden, onReorder }: Props): React.JSX.Element {
  const [conns, setConns] = useState<ConnectionCfg[]>([])
  const [proto, setProto] = useState<'ssh' | 'telnet'>('ssh')
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password')
  const [editing, setEditing] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' })
  const [showPass, setShowPass] = useState(false)
  const [showAdv, setShowAdv] = useState(false)
  const [newline, setNewline] = useState<'lf' | 'cr' | 'crlf'>('lf')
  const [localEcho, setLocalEcho] = useState(false)
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; type: 'session' | 'conn'; id: string } | null>(null)
  const [favCollapse, setFavCollapse] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [favGroups, setFavGroups] = useState<Record<string, string[]>>({})
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const refresh = useCallback(async () => { try { setConns(await rpc<ConnectionCfg[]>('connections.list')) } catch { /* */ } }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const close = (): void => setCtxMenu(null)
    if (ctxMenu !== null) { document.addEventListener('click', close); return () => document.removeEventListener('click', close) }
    return () => {}
  }, [ctxMenu])

  // 持久化收藏到 localStorage
  useEffect(() => {
    try { const s = localStorage.getItem('tm-favorites'); if (s) setFavorites(new Set(JSON.parse(s))) } catch { /* */ }
  }, [])
  useEffect(() => { try { localStorage.setItem('tm-favorites', JSON.stringify([...favorites])) } catch { /* */ } }, [favorites])

  function setField(name: keyof typeof form, value: string): void { setForm(f => ({ ...f, [name]: value })) }
  function resetForm(): void { setEditing(null); setProto('ssh'); setAuthMode('password'); setErrors({}); setShowPass(false); setShowAdv(false); setForm({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' }) }
  function loadConn(c: ConnectionCfg): void { setEditing(c.id); setProto(c.protocol); setAuthMode('password'); setErrors({}); setForm({ label: c.label, host: c.host, port: String(c.port), user: c.username ?? '', pass: '', key: '', passphrase: '', note: c.note ?? '' }) }
  function validate(): boolean {
    const e: Record<string, boolean> = {}
    if (!form.label.trim()) e.label = true
    if (!form.host.trim()) e.host = true
    if (proto === 'ssh') { if (!form.user.trim()) e.user = true; if (authMode === 'password' && !form.pass) e.pass = true; if (authMode === 'key' && !form.key.trim()) e.key = true }
    setErrors(e); return Object.keys(e).length === 0
  }
  async function save(): Promise<void> {
    if (!validate()) return
    const port = Number(form.port) || (proto === 'ssh' ? 22 : 23)
    const base = { label: form.label.trim(), protocol: proto, host: form.host.trim(), port, username: proto === 'ssh' ? form.user.trim() : undefined, note: form.note.trim() || undefined, ...(proto === 'ssh' && authMode === 'password' ? { auth: { kind: 'password' as const, password: form.pass } } : {}), ...(proto === 'ssh' && authMode === 'key' ? { auth: { kind: 'key' as const, privateKey: form.key, passphrase: form.passphrase || undefined } } : {}) }
    try { if (editing !== null) await rpc('connections.update', { id: editing, patch: base }); else await rpc('connections.create', base); await refresh(); resetForm() } catch (err) { alert((err as RpcError).message) }
  }
  async function quickConnect(): Promise<void> {
    if (!validate()) return
    if (editing !== null) { onConnect({ connId: editing }) } else { onConnect({ protocol: proto, host: form.host.trim(), port: Number(form.port) || (proto === 'ssh' ? 22 : 23), ...(proto === 'ssh' ? { username: form.user.trim(), password: form.pass } : {}), label: form.label.trim() }) }
  }
  async function delConn(id: string): Promise<void> { try { await rpc('connections.remove', { id }); await refresh(); if (editing === id) resetForm() } catch { /* */ } }
  const sessionOfConn = (connId: string): SessionSnap | undefined => sessions.find(s => s.connId === connId && s.status !== 'closed')

  // 会话排序：按 sessionOrder（拖动顺序）+ 置顶在最前
  const sortedSessions = [...sessions].sort((a, b) => {
    const ap = pinned.has(a.sessionId) ? -1 : 0; const bp = pinned.has(b.sessionId) ? -1 : 0
    if (ap !== bp) return ap - bp
    const ai = sessionOrder.indexOf(a.sessionId); const bi = sessionOrder.indexOf(b.sessionId)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  function togglePin(sid: string): void { setPinned(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n }); setCtxMenu(null) }
  function startRename(sid: string, label: string): void { setRenameId(sid); setRenameVal(label); setCtxMenu(null) }
  function commitRename(): void { setRenameId(null); setRenameVal('') }
  function toggleFavorite(connId: string): void { setFavorites(prev => { const n = new Set(prev); n.has(connId) ? n.delete(connId) : n.add(connId); return n }); setCtxMenu(null) }

  function onSessionContext(e: React.MouseEvent, s: SessionSnap): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'session', id: s.sessionId }) }
  function onConnContext(e: React.MouseEvent, c: ConnectionCfg): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'conn', id: c.id }) }

  // 拖动排序
  function onDragStart(idx: number): void { setDragIdx(idx) }
  function onDragOver(e: React.DragEvent): void { e.preventDefault() }
  function onDrop(idx: number): void {
    if (dragIdx === null || dragIdx === idx) return
    const newOrder = [...sortedSessions.map(s => s.sessionId)]
    const [moved] = newOrder.splice(dragIdx, 1); newOrder.splice(idx, 0, moved)
    onReorder(newOrder); setDragIdx(null)
  }

  const favConns = conns.filter(c => favorites.has(c.id))
  const otherConns = conns.filter(c => !favorites.has(c.id))

  const pwdInput = (name: keyof typeof form, label: string, placeholder: string, required: boolean, errKey?: string) => (
    <div className={`tm-fld ${errKey && errors[errKey] ? 'error' : ''}`}>
      <label>{label} {required ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label>
      <div className="tm-pwdWrap">
        <input type={showPass ? 'text' : 'password'} value={form[name]} onChange={e => setField(name, e.target.value)} placeholder={placeholder} />
        <span className="tm-pwdToggle" onClick={() => setShowPass(v => !v)}>{showPass ? '隐藏' : '显示'}</span>
      </div>
    </div>
  )

  return (
    <div className="tm-side">
      <div className="tm-sideHead"><span className="t">📡 连接</span></div>
      <div className="tm-ptabs">
        <div className={`tm-ptab ${proto === 'ssh' ? 'on' : ''}`} onClick={() => setProto('ssh')}>SSH</div>
        <div className={`tm-ptab ${proto === 'telnet' ? 'on' : ''}`} onClick={() => setProto('telnet')}>Telnet</div>
      </div>
      <div className="tm-sideScroll">
        {/* 1. 连接参数（不折叠） */}
        <div className="tm-secLabel">连接参数</div>
        <div className={`tm-fld ${errors.label ? 'error' : ''}`}><label>名称 <span className="tm-req">*</span></label><input value={form.label} onChange={e => setField('label', e.target.value)} placeholder="如 web-01" /></div>
        <div className={`tm-fld ${errors.host ? 'error' : ''}`}><label>主机 <span className="tm-req">*</span></label><input value={form.host} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.10" /></div>
        <div style={{ display: 'flex', gap: 7 }}>
          <div className="tm-fld" style={{ flex: '0 0 110px' }}><label style={{ minWidth: '42px' }}>端口</label><input value={form.port} onChange={e => setField('port', e.target.value)} placeholder={proto === 'ssh' ? '22' : '23'} /></div>
          <div className={`tm-fld ${errors.user ? 'error' : ''}`} style={{ flex: 1 }}><label style={{ minWidth: '42px' }}>用户名 {proto === 'ssh' ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label><input value={form.user} onChange={e => setField('user', e.target.value)} placeholder="admin" /></div>
        </div>
        {proto === 'ssh' && (
          <>
            <div className="tm-authSwitch"><span className={authMode === 'password' ? 'on' : ''} onClick={() => setAuthMode('password')}>密码</span><span className={authMode === 'key' ? 'on' : ''} onClick={() => setAuthMode('key')}>密钥</span></div>
            {authMode === 'password' ? pwdInput('pass', '密码', '登录密码', true, 'pass') : (<><div className={`tm-fld ${errors.key ? 'error' : ''}`}><label>私钥 <span className="tm-req">*</span></label><input value={form.key} onChange={e => setField('key', e.target.value)} placeholder="私钥内容或路径" /></div>{pwdInput('passphrase', '口令', '口令', false)}</>)}
          </>
        )}
        <div className="tm-fld"><label>备注 <span className="tm-opt">选填</span></label><input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="用途、位置等" /></div>
        <div className={`tm-advToggle ${showAdv ? 'open' : ''}`} onClick={() => setShowAdv(v => !v)}><span className="arrow">▶</span> 连接选项</div>
        <div className={`tm-advBody ${showAdv ? 'open' : ''}`}>
          <div className="tm-fld"><label>换行</label><select value={newline} onChange={e => setNewline(e.target.value as 'lf' | 'cr' | 'crlf')}><option value="lf">LF (\n)</option><option value="cr">CR (\r)</option><option value="crlf">CRLF (\r\n)</option></select></div>
          <div className="tm-fld"><label>回显</label><input type="checkbox" checked={localEcho} onChange={e => setLocalEcho(e.target.checked)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button className="tm-btn primary" onClick={save}>保存</button><button className="tm-btn" onClick={quickConnect}>连接</button>{editing !== null && <button className="tm-btn" onClick={resetForm}>取消</button>}</div>

        {/* 2. 活跃会话（可折叠） */}
        <CollapsibleSection title="活跃会话" count={sortedSessions.length}>
          {sortedSessions.length === 0 ? <div className="tm-empty">暂无活跃会话</div> : sortedSessions.map((s, idx) => (
            <div key={s.sessionId} className={`tm-ritem ${pinned.has(s.sessionId) ? 'pinned' : ''} ${hiddenSet.has(s.sessionId) ? 'dimmed' : ''}`} draggable onDragStart={() => onDragStart(idx)} onDragOver={onDragOver} onDrop={() => onDrop(idx)} onClick={() => onMarkRead(s.sessionId)} onContextMenu={e => onSessionContext(e, s)} style={{ cursor: 'grab' }}>
              <span className="tm-drag" title="拖动排序">⣿</span>
              <span className={`tm-pico ${s.protocol}`}>{s.protocol.toUpperCase()}</span>
              {renameId === s.sessionId ? (<input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onBlur={commitRename} onKeyDown={e => { if (e.key === 'Enter') commitRename() }} onClick={e => e.stopPropagation()} style={{ flex: 1, fontSize: 12, padding: '2px 6px' }} />) : (<span className="nm">{s.label}</span>)}
              {pinned.has(s.sessionId) && <span style={{ fontSize: 10 }}>📌</span>}
              {hiddenSet.has(s.sessionId) && <span className="tm-eye-off" title="已隐藏">⊘</span>}
              {unreadSet.has(s.sessionId) && <span className="tm-unread" />}
              <button className="tm-eye-btn" onClick={e => { e.stopPropagation(); onToggleHidden(s.sessionId) }} title={hiddenSet.has(s.sessionId) ? '显示' : '隐藏'}>{hiddenSet.has(s.sessionId) ? '👁' : '👁‍🗨'}</button>
            </div>
          ))}
        </CollapsibleSection>

        {/* 3. 收藏（可折叠） */}
        <CollapsibleSection title="⭐ 收藏" count={favConns.length}>
          {favConns.length === 0 ? <div className="tm-empty">暂无收藏</div> : favConns.map(c => {
            const sess = sessionOfConn(c.id); const status = sess?.status ?? 'off'
            return (<div key={c.id} className="tm-ritem" onClick={() => onConnect({ connId: c.id })} onContextMenu={e => onConnContext(e, c)} title="点连接 / 右键菜单"><span className={`tm-pico ${c.protocol}`}>{c.protocol.toUpperCase()}</span><span className="nm">{c.label}</span><span className={`st ${status === 'open' ? 'on' : status === 'connecting' ? 'connecting' : 'off'}`} /></div>)
          })}
        </CollapsibleSection>

        {/* 4. 最近连接（可折叠） */}
        <CollapsibleSection title="最近连接" count={otherConns.length}>
          {otherConns.length === 0 ? <div className="tm-empty">暂无</div> : otherConns.map(c => {
            const sess = sessionOfConn(c.id); const status = sess?.status ?? 'off'
            return (<div key={c.id} className="tm-ritem" onClick={() => onConnect({ connId: c.id })} onContextMenu={e => onConnContext(e, c)} title="点连接 / 右键菜单"><span className={`tm-pico ${c.protocol}`}>{c.protocol.toUpperCase()}</span><span className="nm">{c.label}</span><span className={`st ${status === 'open' ? 'on' : status === 'connecting' ? 'connecting' : 'off'}`} /></div>)
          })}
        </CollapsibleSection>
      </div>

      {/* 右键菜单 */}
      {ctxMenu !== null && (
        <div className="tm-ctxMenu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
          {ctxMenu.type === 'session' && (() => {
            const s = sessions.find(x => x.sessionId === ctxMenu.id); if (s === undefined) return null
            return (
              <>
                <div className="tm-ctxItem" onClick={() => togglePin(ctxMenu.id)}>{pinned.has(ctxMenu.id) ? '取消置顶' : '置顶'}</div>
                <div className="tm-ctxItem" onClick={() => startRename(ctxMenu.id, s.label)}>重命名</div>
                <div className="tm-ctxSep" />
                <div className="tm-ctxItem" style={{ color: 'var(--dsw-alias-state-error-primary, #ef4444)' }} onClick={() => { onDisconnect(ctxMenu.id); setCtxMenu(null) }}>断开</div>
              </>
            )
          })()}
          {ctxMenu.type === 'conn' && (
            <>
              <div className="tm-ctxItem" onClick={() => toggleFavorite(ctxMenu.id)}>{favorites.has(ctxMenu.id) ? '取消收藏' : '收藏'}</div>
              <div className="tm-ctxItem" onClick={() => { const c = conns.find(x => x.id === ctxMenu.id); if (c) loadConn(c); setCtxMenu(null) }}>编辑</div>
              <div className="tm-ctxSep" />
              <div className="tm-ctxItem" style={{ color: 'var(--dsw-alias-state-error-primary, #ef4444)' }} onClick={() => { void delConn(ctxMenu.id); setCtxMenu(null) }}>删除</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

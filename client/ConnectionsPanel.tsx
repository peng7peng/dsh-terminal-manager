/**
 * F2 连接面板 —— 第一批升级修订版。
 * 密码切换(眼睛) + 端口加宽 + 收藏栏(折叠) + 最近连接右键菜单 + 会话右键(显示/隐藏+断开) + 拖动排序
 * @module dsh-terminal-manager/client/ConnectionsPanel
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { rpc, type RpcError } from './rpc.ts'

export interface ConnectionCfg { id: string; label: string; protocol: 'ssh' | 'telnet'; host: string; port: number; username?: string; note?: string }
export interface SessionSnap { sessionId: string; connId?: string; label: string; target: string; protocol: 'ssh' | 'telnet'; status: 'connecting' | 'open' | 'closed' | 'removed' }
export interface ConnectTarget { connId?: string; protocol?: 'ssh' | 'telnet'; host?: string; port?: number; username?: string; password?: string; label?: string }

function CollapsibleSection({ title, count, children }: { title: string; count: number; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      <div className="tm-secLabel" style={{ marginTop: 12, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => setOpen(v => !v)}>
        <span style={{ fontSize: 10, transition: 'transform .2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
        {title} {count > 0 ? '(' + count + ')' : ''}
      </div>
      <div style={{ display: open ? 'block' : 'none' }}>{children}</div>
    </>
  )
}

interface Props {
  sessions: SessionSnap[]
  unreadSet: Set<string>
  hiddenSet: Set<string>
  sessionOrder: string[]
  onConnect: (target: ConnectTarget) => void
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
  onMarkRead: (sessionId: string) => void
  onToggleHidden: (sessionId: string) => void
  onReorder: (newOrder: string[]) => void
}

export function ConnectionsPanel({ sessions, unreadSet, hiddenSet, sessionOrder, onConnect, onDisconnect, onReconnect, onMarkRead, onToggleHidden, onReorder }: Props): React.JSX.Element {
  const [conns, setConns] = useState<ConnectionCfg[]>([])
  const [proto, setProto] = useState<'ssh' | 'telnet'>('ssh')
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password')
  const [editing, setEditing] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' })
  const [showPass, setShowPass] = useState(false)
  const [showAdv, setShowAdv] = useState(false)
  const [newline, setNewline] = useState<'lf' | 'cr' | 'crlf'>('crlf')
  const [localEcho, setLocalEcho] = useState(false)
  const [telnetMode, setTelnetMode] = useState<'telnet' | 'raw'>('raw')
  const [handshakeTimeout, setHandshakeTimeout] = useState<number>(15)
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; type: 'session' | 'conn'; id: string } | null>(null)
  const [favCollapse, setFavCollapse] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const refresh = useCallback(async () => { try { setConns(await rpc<ConnectionCfg[]>('connections.list')) } catch { /* */ } }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const close = (): void => setCtxMenu(null)
    if (ctxMenu !== null) { document.addEventListener('click', close); return () => document.removeEventListener('click', close) }
    return () => {}
  }, [ctxMenu])
  useEffect(() => { try { const s = localStorage.getItem('tm-favorites'); if (s) setFavorites(new Set(JSON.parse(s))) } catch { /* */ } }, [])
  useEffect(() => { try { localStorage.setItem('tm-favorites', JSON.stringify([...favorites])) } catch { /* */ } }, [favorites])

  function setField(name: keyof typeof form, value: string): void { setForm(f => ({ ...f, [name]: value })) }
  function resetForm(): void { setEditing(null); setProto('ssh'); setAuthMode('password'); setErrors({}); setShowPass(false); setShowAdv(false); setTelnetMode('raw'); setHandshakeTimeout(15); setNewline('crlf'); setLocalEcho(false); setForm({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' }) }
  function loadConn(c: ConnectionCfg): void { setEditing(c.id); setProto(c.protocol); setAuthMode('password'); setErrors({}); setTelnetMode(c.telnetMode ?? 'raw'); setHandshakeTimeout(c.handshakeTimeoutSec ?? 15); setNewline(c.newline ?? 'crlf'); setLocalEcho(c.localEcho ?? false); setForm({ label: c.label, host: c.host, port: String(c.port), user: c.username ?? '', pass: '', key: '', passphrase: '', note: c.note ?? '' }) }
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
    const base = { label: form.label.trim(), protocol: proto, host: form.host.trim(), port, username: proto === 'ssh' ? form.user.trim() : undefined, note: form.note.trim() || undefined, ...(proto === 'ssh' && authMode === 'password' ? { auth: { kind: 'password' as const, password: form.pass } } : {}), ...(proto === 'ssh' && authMode === 'key' ? { auth: { kind: 'key' as const, privateKey: form.key, passphrase: form.passphrase || undefined } } : {}), ...(proto === 'telnet' ? { telnetMode } : {}), ...(proto === 'ssh' && handshakeTimeout !== 15 ? { handshakeTimeoutSec: handshakeTimeout } : {}), newline, localEcho }
    try { if (editing !== null) await rpc('connections.update', { id: editing, patch: base }); else { const created = await rpc<ConnectionCfg>('connections.create', base); setFavorites(prev => { const n = new Set(prev); n.add(created.id); return n }) } await refresh(); resetForm() } catch (err) { alert((err as RpcError).message) }
  }
  async function quickConnect(): Promise<void> {
    if (!validate()) return
    if (editing !== null) { onConnect({ connId: editing }) } else { onConnect({ protocol: proto, host: form.host.trim(), port: Number(form.port) || (proto === 'ssh' ? 22 : 23), ...(proto === 'ssh' ? { username: form.user.trim(), password: form.pass } : {}), ...(proto === 'telnet' && telnetMode !== 'raw' ? { telnetMode } : {}), ...(proto === 'ssh' && handshakeTimeout !== 15 ? { connectTimeoutMs: handshakeTimeout * 1000 } : {}), label: form.label.trim() }) }
  }
  async function delConn(id: string): Promise<void> { try { await rpc('connections.remove', { id }); await refresh(); if (editing === id) resetForm() } catch { /* */ } }
  const sessionOfConn = (connId: string): SessionSnap | undefined => sessions.find(s => s.connId === connId && s.status !== 'removed')
  const sortedSessions = [...sessions].sort((a, b) => { const ap = pinned.has(a.sessionId) ? -1 : 0; const bp = pinned.has(b.sessionId) ? -1 : 0; if (ap !== bp) return ap - bp; const ai = sessionOrder.indexOf(a.sessionId); const bi = sessionOrder.indexOf(b.sessionId); return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) })
  function togglePin(sid: string): void { setPinned(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n }); setCtxMenu(null) }
  function startRename(sid: string, label: string): void { setRenameId(sid); setRenameVal(label); setCtxMenu(null) }
  function commitRename(): void { setRenameId(null); setRenameVal('') }
  function toggleFavorite(connId: string): void { setFavorites(prev => { const n = new Set(prev); n.has(connId) ? n.delete(connId) : n.add(connId); return n }); setCtxMenu(null) }
  function onSessionContext(e: React.MouseEvent, s: SessionSnap): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'session', id: s.sessionId }) }
  function onConnContext(e: React.MouseEvent, c: ConnectionCfg): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'conn', id: c.id }) }
  function onDragStart(idx: number): void { setDragIdx(idx) }
  function onDragOver(e: React.DragEvent): void { e.preventDefault() }
  function onDrop(idx: number): void { if (dragIdx === null || dragIdx === idx) return; const newOrder = [...sortedSessions.map(s => s.sessionId)]; const [moved] = newOrder.splice(dragIdx, 1); newOrder.splice(idx, 0, moved); onReorder(newOrder); setDragIdx(null) }

  const favConns = conns.filter(c => favorites.has(c.id))
  const otherConns = conns.filter(c => !favorites.has(c.id)).slice(0, 7) // 最近连接最多保留 7 个

  const pwdInput = (name: keyof typeof form, label: string, placeholder: string, required: boolean, errKey?: string, hint?: string) => (
    <div className={'tm-fld ' + (errKey && errors[errKey] ? 'error' : '')}>
      <label title={hint}>{label} {required ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label>
      <div className="tm-pwdWrap">
        <input type={showPass ? 'text' : 'password'} value={form[name]} onChange={e => setField(name, e.target.value)} placeholder={placeholder} />
        <span className="tm-pwdToggle" onClick={() => setShowPass(v => !v)} title={showPass ? '点击隐藏密码' : '点击显示密码'}>{showPass ? '👁' : '👁‍🗨'}</span>
      </div>
    </div>
  )

  const renderConn = (c: ConnectionCfg) => {
    const sess = sessionOfConn(c.id); const status = sess?.status ?? 'off'
    const sub = (c.username ? c.username + '@' : '') + c.host + ':' + c.port

    // 智能路由：根据会话状态决定点击行为
    const handleClick = () => {
      if (status === 'open') {
        // 已有 open 会话，聚焦（切换显示）
        if (sess) onToggleHidden(sess.sessionId)
      } else if (status === 'closed') {
        // 被动断开，重连
        if (sess) onReconnect(sess.sessionId)
      } else {
        // 无会话或 removed，创建新会话
        onConnect({ connId: c.id })
      }
    }

    const statusClass = status === 'open' ? 'on' : status === 'connecting' ? 'connecting' : status === 'closed' ? 'closed' : 'off'
    const title = status === 'open' ? '已连接 - 点击聚焦' : status === 'closed' ? '已断开 - 点击重连' : '点击连接'

    return <div key={c.id} className="tm-ritem" onClick={handleClick} onContextMenu={e => onConnContext(e, c)} title={title}><span className={'tm-pico ' + c.protocol}>{c.protocol.toUpperCase()}</span><span className="nm">{c.label}<span className="tm-sub">{sub}</span></span><span className={'st ' + statusClass} /></div>
  }

  return (
    <div className="tm-side">
      <div className="tm-sideHead">
        <span className="t">📡 连接</span>
        <div className="tm-ptabs" style={{ flex: 1, marginLeft: 8 }}>
          <div className={'tm-ptab ' + (proto === 'ssh' ? 'on' : '')} onClick={() => setProto('ssh')} title="SSH：加密远程登录，需用户名+密码或私钥">SSH</div>
          <div className={'tm-ptab ' + (proto === 'telnet' ? 'on' : '')} onClick={() => setProto('telnet')} title="Telnet：明文远程登录，常用于网络设备（ESL 环境）">Telnet</div>
        </div>
      </div>
      <div className="tm-sideScroll">
        <div className="tm-secLabel">连接参数</div>
        <div className={'tm-fld ' + (errors.label ? 'error' : '')}><label title="给这个连接起个名字，方便在列表里区分">名称 <span className="tm-req">*</span></label><input value={form.label} onChange={e => setField('label', e.target.value)} placeholder="如 web-01" /></div>
        <div className={'tm-fld ' + (errors.host ? 'error' : '')}><label title="设备的 IP 地址或主机名，如 192.168.1.10 或 dev-router-01">主机 <span className="tm-req">*</span></label><input value={form.host} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.10" /></div>
        <div style={{ display: 'flex', gap: 7 }}>
          <div className="tm-fld" style={{ flex: '0 0 110px' }}><label style={{ minWidth: '42px' }} title="SSH 默认 22，Telnet 默认 23；改了端口的设备填实际端口">端口</label><input value={form.port} onChange={e => setField('port', e.target.value)} placeholder={proto === 'ssh' ? '22' : '23'} /></div>
          <div className={'tm-fld ' + (errors.user ? 'error' : '')} style={{ flex: 1 }}><label style={{ minWidth: '42px' }} title="登录账号名；SSH 必填，Telnet 一般留空">用户名 {proto === 'ssh' ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label><input value={form.user} onChange={e => setField('user', e.target.value)} placeholder="admin" /></div>
        </div>
        {proto === 'ssh' && (
          <>
            <div className="tm-authSwitch"><span className={authMode === 'password' ? 'on' : ''} onClick={() => setAuthMode('password')} title="用账号密码登录">密码</span><span className={authMode === 'key' ? 'on' : ''} onClick={() => setAuthMode('key')} title="用 SSH 私钥登录（更安全）">密钥</span></div>
            {authMode === 'password' ? pwdInput('pass', '密码', '登录密码', true, 'pass', 'SSH 登录密码') : (<><div className={'tm-fld ' + (errors.key ? 'error' : '')}><label title="SSH 私钥的内容或文件路径；公钥需事先装到设备上">私钥 <span className="tm-req">*</span></label><input value={form.key} onChange={e => setField('key', e.target.value)} placeholder="私钥内容或路径" /></div>{pwdInput('passphrase', '口令', '口令', false, undefined, '私钥本身的口令；私钥没加密时留空')}</>)}
          </>
        )}
        {proto === 'telnet' && (
          <div className="tm-authSwitch"><span className={telnetMode === 'raw' ? 'on' : ''} onClick={() => setTelnetMode('raw')} title="裸 TCP 直连：不协商 Telnet 协议，原样收发字节">Raw TCP</span><span className={telnetMode === 'telnet' ? 'on' : ''} onClick={() => setTelnetMode('telnet')} title="按 Telnet 协议协商：自动剥离 IAC 控制字节（多数网络设备用这个）">Telnet</span></div>
        )}
        <div className="tm-fld"><label title="随手记，不影响连接；可写用途、机房位置等">备注 <span className="tm-opt">选填</span></label><input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="用途、位置等" /></div>
        <div className={'tm-advToggle ' + (showAdv ? 'open' : '')} onClick={() => setShowAdv(v => !v)} title="展开/收起高级连接参数"><span className="arrow">▶</span> 连接选项</div>
        <div className={'tm-advBody ' + (showAdv ? 'open' : '')}>
          {proto === 'ssh' && <div className="tm-fld"><label title="SSH 握手超时；网络慢或设备响应慢时调大，默认 15 秒">握手超时</label><select value={handshakeTimeout} onChange={e => setHandshakeTimeout(Number(e.target.value))}><option value={15}>15 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>120 秒</option><option value={180}>180 秒</option></select></div>}
          <div style={{ display: 'flex', gap: 7 }}>
            <div className="tm-fld" style={{ flex: 1 }}><label title="发送命令时每行末尾追加的换行符；多数网络设备用 CRLF（\r\n），部分设备用 LF">换行</label><select value={newline} onChange={e => setNewline(e.target.value as 'lf' | 'cr' | 'crlf')}><option value="lf">LF (\n)</option><option value="cr">CR (\r)</option><option value="crlf">CRLF (\r\n)</option></select></div>
            <div className="tm-fld" style={{ flex: '0 0 auto' }}><label title="本地回显：自己敲的字符是否在终端上显示。设备本身不回显输入时（部分串口/Telnet）开启；设备已回显则关闭，否则会出现双字符">回显</label><input type="checkbox" checked={localEcho} onChange={e => setLocalEcho(e.target.checked)} /></div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button className="tm-btn primary" onClick={save}>保存</button><button className="tm-btn" onClick={quickConnect}>连接</button>{editing !== null && <button className="tm-btn" onClick={resetForm}>取消</button>}</div>

        <CollapsibleSection title="活跃会话" count={sortedSessions.length}>
          {sortedSessions.length === 0 ? <div className="tm-empty">暂无活跃会话</div> : sortedSessions.map((s, idx) => {
            const isClosed = s.status === 'closed'
            const handleClick = () => {
              onMarkRead(s.sessionId)
              if (isClosed) {
                // 被动断开，点击重连
                onReconnect(s.sessionId)
              } else {
                // open 状态，切换显示/隐藏
                onToggleHidden(s.sessionId)
              }
            }
            return (
              <div key={s.sessionId} className={'tm-ritem ' + (pinned.has(s.sessionId) ? 'pinned ' : '') + (hiddenSet.has(s.sessionId) ? 'dimmed ' : '') + (isClosed ? 'disconnected' : '')} draggable onDragStart={() => onDragStart(idx)} onDragOver={onDragOver} onDrop={() => onDrop(idx)} onClick={handleClick} onContextMenu={e => onSessionContext(e, s)} style={{ cursor: 'pointer' }} title={isClosed ? '已断开 - 点击重连' : '点击切换显示'}>
                <span className="tm-drag" title="拖动排序">⣿</span>
                <span className={'tm-pico ' + s.protocol}>{s.protocol.toUpperCase()}</span>
                {renameId === s.sessionId ? (<input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onBlur={commitRename} onKeyDown={e => { if (e.key === 'Enter') commitRename() }} onClick={e => e.stopPropagation()} style={{ flex: 1, fontSize: 12, padding: '2px 6px' }} />) : (<span className="nm">{s.label}<span className="tm-sub">{s.target}</span>{isClosed && <span className="tm-disconnected-hint">点击重连</span>}</span>)}
                {pinned.has(s.sessionId) && <span style={{ fontSize: 10 }}>📌</span>}
                {hiddenSet.has(s.sessionId) && <span className="tm-eye-off" title="已隐藏">⊘</span>}
                {unreadSet.has(s.sessionId) && <span className="tm-unread" />}
              </div>
            )
          })}
        </CollapsibleSection>

        <CollapsibleSection title="⭐ 收藏" count={favConns.length}>
          {favConns.length === 0 ? <div className="tm-empty">暂无收藏</div> : favConns.map(c => renderConn(c))}
        </CollapsibleSection>

        <CollapsibleSection title="最近连接" count={otherConns.length}>
          {otherConns.length === 0 ? <div className="tm-empty">暂无</div> : otherConns.map(c => renderConn(c))}
        </CollapsibleSection>
      </div>

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

/**
 * F2 连接面板 —— 第一批升级修订版。
 * 密码切换(眼睛) + 端口加宽 + 收藏栏(折叠) + 最近连接右键菜单 + 会话右键(显示/隐藏+断开) + 拖动排序
 * @module dsh-terminal-manager/client/ConnectionsPanel
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconLinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryPicker } from './ext/port-log/DirectoryPicker.tsx'
import { portLogRpc } from './ext/port-log/rpc.ts'
import { getDefaultLogDirectory, loadDefaultLogDirectory, usePortLogState } from './ext/port-log/store.ts'
import { rpc, type RpcError } from './rpc.ts'

export interface ConnectionCfg { id: string; label: string; protocol: 'ssh' | 'telnet'; host: string; port: number; username?: string; note?: string; favorited?: boolean }
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
  /** sessionId → TC 编号（D1/D4）；缺省不显示徽章 */
  tcMap?: ReadonlyMap<string, number>
  onConnect: (target: ConnectTarget) => Promise<SessionSnap | undefined>
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
  onFocus: (sessionId: string) => void
  onMarkRead: (sessionId: string) => void
  onToggleHidden: (sessionId: string) => void
  onReorder: (newOrder: string[]) => void
}

export function ConnectionsPanel({ sessions, unreadSet, hiddenSet, sessionOrder, tcMap, onConnect, onDisconnect, onReconnect, onFocus, onMarkRead, onToggleHidden, onReorder }: Props): React.JSX.Element {
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
  const [telnetMode, setTelnetMode] = useState<'telnet' | 'raw'>('telnet')
  const [handshakeTimeout, setHandshakeTimeout] = useState<number>(15)
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; type: 'session' | 'conn'; id: string } | null>(null)
  const [favCollapse, setFavCollapse] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [logEnabled, setLogEnabled] = useState(false)
  const [logTimestamp, setLogTimestamp] = useState(true)
  const [logStripAnsi, setLogStripAnsi] = useState(true)
  const [logDirectory, setLogDirectory] = useState('')
  const [showDirPicker, setShowDirPicker] = useState(false)
  const [logDirectoryError, setLogDirectoryError] = useState<string | null>(null)
  const portLogState = usePortLogState()
  const sessionLogMap = new Map(portLogState.sessionLogs.map(l => [l.sessionId, l]))
  useEffect(() => { void loadDefaultLogDirectory().catch(() => { /* 勾选日志时允许重试并显示错误。 */ }) }, [])

  async function toggleLog(enabled: boolean): Promise<void> {
    setLogDirectoryError(null)
    if (!enabled) { setLogEnabled(false); setShowDirPicker(false); return }
    try {
      const directory = logDirectory || await loadDefaultLogDirectory()
      setLogDirectory(directory)
      setLogEnabled(true)
    } catch (error) {
      setLogDirectoryError(error instanceof Error ? error.message : '无法读取默认日志目录')
    }
  }

  const refresh = useCallback(async () => { try { setConns(await rpc<ConnectionCfg[]>('connections.list')) } catch { /* */ } }, [])
  useEffect(() => { void refresh() }, [refresh])
  // 当会话列表增加时（AI 工具或其他方式新建了会话），重拉连接列表
  const prevSessionCount = useRef(sessions.length)
  useEffect(() => {
    if (sessions.length > prevSessionCount.current) void refresh()
    prevSessionCount.current = sessions.length
  }, [sessions.length, refresh])
  useEffect(() => {
    const close = (): void => setCtxMenu(null)
    if (ctxMenu !== null) { document.addEventListener('click', close); return () => document.removeEventListener('click', close) }
    return () => {}
  }, [ctxMenu])

  function setField(name: keyof typeof form, value: string): void { setForm(f => ({ ...f, [name]: value })) }
  function resetForm(): void { setEditing(null); setProto('ssh'); setAuthMode('password'); setErrors({}); setShowPass(false); setShowAdv(false); setTelnetMode('raw'); setHandshakeTimeout(15); setNewline('crlf'); setLocalEcho(false); setLogEnabled(false); setLogTimestamp(true); setLogStripAnsi(true); setLogDirectory(''); setShowDirPicker(false); setForm({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' }) }
  function loadConn(c: ConnectionCfg): void { setEditing(c.id); setProto(c.protocol); setAuthMode('password'); setErrors({}); setTelnetMode(c.telnetMode ?? 'raw'); setHandshakeTimeout(c.connectTimeoutMs ? Math.round(c.connectTimeoutMs / 1000) : 15); setNewline(c.newline ?? 'crlf'); setLocalEcho(c.localEcho ?? false); setLogEnabled(false); setLogTimestamp(true); setLogStripAnsi(true); setLogDirectory(''); setShowDirPicker(false); setForm({ label: c.label, host: c.host, port: String(c.port), user: c.username ?? '', pass: '', key: '', passphrase: '', note: c.note ?? '' }) }
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
    const base = { label: form.label.trim(), protocol: proto, host: form.host.trim(), port, username: proto === 'ssh' ? form.user.trim() : undefined, note: form.note.trim() || undefined, ...(proto === 'ssh' && authMode === 'password' ? { auth: { kind: 'password' as const, password: form.pass } } : {}), ...(proto === 'ssh' && authMode === 'key' ? { auth: { kind: 'key' as const, privateKey: form.key, passphrase: form.passphrase || undefined } } : {}), ...(proto === 'telnet' ? { telnetMode } : {}), ...(proto === 'ssh' && handshakeTimeout !== 15 ? { connectTimeoutMs: handshakeTimeout * 1000 } : {}), newline, localEcho }
    try { if (editing !== null) await rpc('connections.update', { id: editing, patch: base }); else await rpc('connections.create', base); await refresh(); resetForm() } catch (err) { alert((err as RpcError).message) }
  }
  async function quickConnect(): Promise<void> {
    if (!validate()) return
    const snap = editing !== null
      ? await onConnect({ connId: editing })
      : await onConnect({ protocol: proto, host: form.host.trim(), port: Number(form.port) || (proto === 'ssh' ? 22 : 23), ...(proto === 'ssh' ? { username: form.user.trim(), password: form.pass } : {}), ...(proto === 'telnet' && telnetMode !== 'raw' ? { telnetMode } : {}), ...(proto === 'ssh' && handshakeTimeout !== 15 ? { connectTimeoutMs: handshakeTimeout * 1000 } : {}), label: form.label.trim() })
    if (logEnabled && snap) {
      try { await portLogRpc('sessionLogs.start', { sessionId: snap.sessionId, timestamp: logTimestamp, stripAnsi: logStripAnsi, ...(logDirectory.trim() ? { directory: logDirectory.trim() } : {}) }) } catch { /* silent */ }
    }
  }
  async function delConn(id: string): Promise<void> { try { await rpc('connections.remove', { id }); await refresh(); if (editing === id) resetForm() } catch { /* */ } }

  // 检查当前表单是否与已收藏的连接重复（protocol + host + port + username）
  const isDuplicateFavorite = (): boolean => {
    if (editing !== null) return false // 编辑模式不算重复
    const host = form.host.trim()
    const port = Number(form.port) || (proto === 'ssh' ? 22 : 23)
    const username = proto === 'ssh' ? form.user.trim() : undefined
    if (!host) return false
    return conns.some(c => c.favorited !== false && c.protocol === proto && c.host === host && c.port === port && (proto === 'ssh' ? c.username === username : true))
  }

  // 查找会话：先按 connId 精确匹配，再按目标（protocol:host:port）模糊匹配
  const sessionOfConn = (connId: string): SessionSnap | undefined => {
    // 精确匹配 connId
    const byConnId = sessions.find(s => s.connId === connId && s.status !== 'removed')
    if (byConnId) return byConnId
    // 模糊匹配目标（同一目标的多个连接配置共享会话）
    const conn = conns.find(c => c.id === connId)
    if (!conn) return undefined
    const target = `${conn.protocol}:${conn.host}:${conn.port}`
    return sessions.find(s => s.target === target && s.protocol === conn.protocol && s.status !== 'removed')
  }
  const sortedSessions = [...sessions].sort((a, b) => { const ap = pinned.has(a.sessionId) ? -1 : 0; const bp = pinned.has(b.sessionId) ? -1 : 0; if (ap !== bp) return ap - bp; const ai = sessionOrder.indexOf(a.sessionId); const bi = sessionOrder.indexOf(b.sessionId); return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) })
  function togglePin(sid: string): void { setPinned(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n }); setCtxMenu(null) }
  function startRename(sid: string, label: string): void { setRenameId(sid); setRenameVal(label); setCtxMenu(null) }
  function commitRename(): void { setRenameId(null); setRenameVal('') }
  async function toggleFavorite(connId: string): Promise<void> {
    const c = conns.find(x => x.id === connId)
    if (!c) return
    try { await rpc('connections.update', { id: connId, patch: { ...c, favorited: c.favorited === false } }); await refresh() } catch { /* */ }
    setCtxMenu(null)
  }
  function onSessionContext(e: React.MouseEvent, s: SessionSnap): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'session', id: s.sessionId }) }
  function onConnContext(e: React.MouseEvent, c: ConnectionCfg): void { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, type: 'conn', id: c.id }) }
  function onDragStart(idx: number): void { setDragIdx(idx) }
  function onDragOver(e: React.DragEvent): void { e.preventDefault() }
  function onDrop(idx: number): void { if (dragIdx === null || dragIdx === idx) return; const newOrder = [...sortedSessions.map(s => s.sessionId)]; const [moved] = newOrder.splice(dragIdx, 1); newOrder.splice(idx, 0, moved); onReorder(newOrder); setDragIdx(null) }

  const favConns = conns.filter(c => c.favorited !== false)
  const otherConns = conns.filter(c => c.favorited === false).slice(0, 7) // 最近连接最多保留 7 个

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
        // 已有 open 会话，聚焦（切换显示 + 闪烁提示）
        if (sess) {
          onToggleHidden(sess.sessionId)
          onFocus(sess.sessionId)
        }
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
        <span className="t"><IconLinkOutline14 className="tm-sideIcon" /> 连接</span>
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
          <div style={{ display: 'flex', gap: 7, marginTop: 4 }}>
            <div className="tm-fld" style={{ flex: '0 0 auto' }}><label title="连接后自动记录该会话的输出到日志文件">日志</label><input type="checkbox" checked={logEnabled} onChange={e => { void toggleLog(e.target.checked) }} /></div>
            {logEnabled && <>
              <div className="tm-fld" style={{ flex: '0 0 auto' }}><label>时间戳</label><input type="checkbox" checked={logTimestamp} onChange={e => setLogTimestamp(e.target.checked)} /></div>
              <div className="tm-fld" style={{ flex: '0 0 auto' }}><label>清理ANSI</label><input type="checkbox" checked={logStripAnsi} onChange={e => setLogStripAnsi(e.target.checked)} /></div>
            </>}
          </div>
          {logEnabled && <div className="tm-fld"><label title="日志文件存放目录；默认为插件数据目录下的 session_logs">日志目录</label><input value={logDirectory || getDefaultLogDirectory()} readOnly style={{ cursor: 'default' }} /><button type="button" className="tm-btn" disabled={showDirPicker} style={{ flex: 'none', fontSize: 11, padding: '4px 8px' }} onClick={() => { setLogDirectoryError(null); setShowDirPicker(true) }}>浏览</button></div>}
          {logDirectoryError && <div className="tm-mNote" role="alert">{logDirectoryError}</div>}
          {showDirPicker && <DirectoryPicker onSelect={path => { setLogDirectory(path); setShowDirPicker(false) }} onCancel={() => setShowDirPicker(false)} onError={message => { setLogDirectoryError(message); setShowDirPicker(false) }} />}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {isDuplicateFavorite() ? (
            <button className="tm-btn primary" disabled style={{ opacity: 0.6, cursor: 'not-allowed' }}>已收藏</button>
          ) : (
            <button className="tm-btn primary" onClick={save}>收藏</button>
          )}
          <button className="tm-btn" onClick={quickConnect}>连接</button>
          {editing !== null && <button className="tm-btn" onClick={resetForm}>取消</button>}
        </div>

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
              <div key={s.sessionId} className={'tm-ritem ' + (pinned.has(s.sessionId) ? 'pinned ' : '') + (hiddenSet.has(s.sessionId) ? 'dimmed ' : '') + (isClosed ? 'disconnected' : '')} draggable={sortedSessions.length > 1} onDragStart={() => onDragStart(idx)} onDragOver={onDragOver} onDrop={() => onDrop(idx)} onClick={handleClick} onContextMenu={e => onSessionContext(e, s)} style={{ cursor: 'pointer' }} title={isClosed ? '已断开 - 点击重连' : '点击切换显示'}>
                <span className="tm-drag" title={sortedSessions.length > 1 ? "拖动排序 = 切换 TC 编号" : "只有一个会话，无需排序"} style={sortedSessions.length > 1 ? undefined : { opacity: 0.3, cursor: "default" }}>⣿</span>
                {tcMap?.has(s.sessionId) && <span className="tm-tcn" title="活跃会话顺序编号">{tcMap.get(s.sessionId)}</span>}
                <span className={'tm-pico ' + s.protocol}>{s.protocol.toUpperCase()}</span>
                {renameId === s.sessionId ? (<input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onBlur={commitRename} onKeyDown={e => { if (e.key === 'Enter') commitRename() }} onClick={e => e.stopPropagation()} style={{ flex: 1, fontSize: 12, padding: '2px 6px' }} />) : (<span className="nm">{s.label}<span className="tm-sub">{s.target}</span>{isClosed && <span className="tm-disconnected-hint">点击重连</span>}</span>)}
                {pinned.has(s.sessionId) && <span style={{ fontSize: 10 }}>📌</span>}
                {hiddenSet.has(s.sessionId) && <span className="tm-eye-off" title="已隐藏">⊘</span>}
                {unreadSet.has(s.sessionId) && <span className="tm-unread" />}
                {sessionLogMap.has(s.sessionId) && <span style={{ fontSize: 9, color: 'var(--dsw-alias-state-success-primary, #22c55e)', fontWeight: 700, flex: 'none' }} title="日志记录中">LOG</span>}
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
            const hasLog = sessionLogMap.has(s.sessionId)
            return (
              <>
                <div className="tm-ctxItem" onClick={() => togglePin(ctxMenu.id)}>{pinned.has(ctxMenu.id) ? '取消置顶' : '置顶'}</div>
                <div className="tm-ctxItem" onClick={() => startRename(ctxMenu.id, s.label)}>重命名</div>
                {s.status === 'open' && <div className="tm-ctxItem" onClick={async () => { try { if (hasLog) await portLogRpc('sessionLogs.stop', { sessionId: s.sessionId }); else await portLogRpc('sessionLogs.start', { sessionId: s.sessionId, timestamp: true, stripAnsi: true }) } catch { /* */ } setCtxMenu(null) }}>{hasLog ? '停止日志' : '开启日志'}</div>}
                <div className="tm-ctxSep" />
                <div className="tm-ctxItem" style={{ color: 'var(--dsw-alias-state-error-primary, #ef4444)' }} onClick={() => { onDisconnect(ctxMenu.id); setCtxMenu(null) }}>断开</div>
              </>
            )
          })()}
          {ctxMenu.type === 'conn' && (
            <>
              <div className="tm-ctxItem" onClick={() => toggleFavorite(ctxMenu.id)}>{(conns.find(c => c.id === ctxMenu.id)?.favorited !== false) ? '取消收藏' : '收藏'}</div>
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

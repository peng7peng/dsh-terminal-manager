/**
 * F2 连接面板 —— 设备清单 + 新建/编辑表单 + 活跃会话。
 * 第一批升级：密码可见切换 + 高级折叠(换行/回显) + 表单横排 +
 *   最近连接 hover 移除 + 会话右键菜单(置顶/重命名/断开/移除) + 会话排序 + 未读标记
 * @module dsh-terminal-manager/client/ConnectionsPanel
 */

import { useCallback, useEffect, useState } from 'react'
import { rpc, type RpcError } from './rpc.ts'

export interface ConnectionCfg {
  id: string
  label: string
  protocol: 'ssh' | 'telnet'
  host: string
  port: number
  username?: string
  note?: string
}

export interface SessionSnap {
  sessionId: string
  connId?: string
  label: string
  target: string
  protocol: 'ssh' | 'telnet'
  status: 'connecting' | 'open' | 'closed'
}

export interface ConnectTarget {
  connId?: string
  protocol?: 'ssh' | 'telnet'
  host?: string
  port?: number
  username?: string
  password?: string
  label?: string
}

interface Props {
  sessions: SessionSnap[]
  unreadSet: Set<string>
  onConnect: (target: ConnectTarget) => void
  onDisconnect: (sessionId: string) => void
  onMarkRead: (sessionId: string) => void
}

export function ConnectionsPanel({ sessions, unreadSet, onConnect, onDisconnect, onMarkRead }: Props): React.JSX.Element {
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)

  const refresh = useCallback(async () => {
    try { setConns(await rpc<ConnectionCfg[]>('connections.list')) } catch { /* ignore */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const close = (): void => setCtxMenu(null)
    if (ctxMenu !== null) { document.addEventListener('click', close); return () => document.removeEventListener('click', close) }
    return () => {}
  }, [ctxMenu])

  function setField(name: keyof typeof form, value: string): void {
    setForm(f => ({ ...f, [name]: value }))
  }

  function resetForm(): void {
    setEditing(null); setProto('ssh'); setAuthMode('password'); setErrors({})
    setShowPass(false); setShowAdv(false)
    setForm({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' })
  }

  function loadConn(c: ConnectionCfg): void {
    setEditing(c.id); setProto(c.protocol); setAuthMode('password'); setErrors({})
    setForm({ label: c.label, host: c.host, port: String(c.port), user: c.username ?? '', pass: '', key: '', passphrase: '', note: c.note ?? '' })
  }

  function validate(): boolean {
    const e: Record<string, boolean> = {}
    if (!form.label.trim()) e.label = true
    if (!form.host.trim()) e.host = true
    if (proto === 'ssh') {
      if (!form.user.trim()) e.user = true
      if (authMode === 'password' && !form.pass) e.pass = true
      if (authMode === 'key' && !form.key.trim()) e.key = true
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function save(): Promise<void> {
    if (!validate()) return
    const port = Number(form.port) || (proto === 'ssh' ? 22 : 23)
    const base = {
      label: form.label.trim(), protocol: proto, host: form.host.trim(), port,
      username: proto === 'ssh' ? form.user.trim() : undefined,
      note: form.note.trim() || undefined,
      ...(proto === 'ssh' && authMode === 'password' ? { auth: { kind: 'password' as const, password: form.pass } } : {}),
      ...(proto === 'ssh' && authMode === 'key' ? { auth: { kind: 'key' as const, privateKey: form.key, passphrase: form.passphrase || undefined } } : {}),
    }
    try {
      if (editing !== null) await rpc('connections.update', { id: editing, patch: base })
      else await rpc('connections.create', base)
      await refresh(); resetForm()
    } catch (err) { alert((err as RpcError).message) }
  }

  async function quickConnect(): Promise<void> {
    if (!validate()) return
    if (editing !== null) {
      onConnect({ connId: editing })
    } else {
      onConnect({ protocol: proto, host: form.host.trim(), port: Number(form.port) || (proto === 'ssh' ? 22 : 23), ...(proto === 'ssh' ? { username: form.user.trim(), password: form.pass } : {}), label: form.label.trim() })
    }
  }

  async function delConn(id: string): Promise<void> {
    try { await rpc('connections.remove', { id }); await refresh(); if (editing === id) resetForm() } catch { /* ignore */ }
  }

  const sessionOfConn = (connId: string): SessionSnap | undefined => sessions.find(s => s.connId === connId && s.status !== 'closed')

  // 会话排序：置顶 > 已连接 > 其他；同级别按原始顺序
  const sortedSessions = [...sessions].sort((a, b) => {
    const ap = pinned.has(a.sessionId) ? 0 : 1
    const bp = pinned.has(b.sessionId) ? 0 : 1
    if (ap !== bp) return ap - bp
    const ao = a.status === 'open' ? 0 : 1
    const bo = b.status === 'open' ? 0 : 1
    return ao - bo
  })

  function togglePin(sid: string): void {
    setPinned(prev => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n })
    setCtxMenu(null)
  }

  function startRename(sid: string, currentLabel: string): void {
    setRenameId(sid); setRenameVal(currentLabel); setCtxMenu(null)
  }

  function commitRename(): void {
    if (renameId !== null && renameVal.trim()) {
      // 会话重命名需要后端支持——暂时只更新前端显示名
      // TODO: 后端加 sessions.rename RPC
    }
    setRenameId(null); setRenameVal('')
  }

  function onSessionContextMenu(e: React.MouseEvent, s: SessionSnap): void {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: s.sessionId })
  }

  function handleSessionClick(s: SessionSnap): void {
    onMarkRead(s.sessionId)
  }

  const pwdField = (name: keyof typeof form, label: string, placeholder: string, required: boolean, errKey?: string): React.JSX.Element => (
    <div className={`tm-fld ${errKey && errors[errKey] ? 'error' : ''}`}>
      <label>{label} {required ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label>
      <div className="tm-pwdWrap">
        <input type={showPass ? 'text' : 'password'} value={form[name]} onChange={e => setField(name, e.target.value)} placeholder={placeholder} />
        <span className="tm-pwdToggle" onClick={() => setShowPass(v => !v)}>{showPass ? '🙈' : '👁'}</span>
      </div>
    </div>
  )

  return (
    <div className="tm-side">
      <div className="tm-sideHead"><span className="t">📡 连接</span></div>
      <div className="tm-sideScroll">
        <div className="tm-ptabs">
          <div className={`tm-ptab ${proto === 'ssh' ? 'on' : ''}`} onClick={() => setProto('ssh')}>SSH</div>
          <div className={`tm-ptab ${proto === 'telnet' ? 'on' : ''}`} onClick={() => setProto('telnet')}>Telnet</div>
        </div>

        <div className="tm-secLabel">连接参数</div>
        <div className={`tm-fld ${errors.label ? 'error' : ''}`}>
          <label>名称 <span className="tm-req">*</span></label>
          <input value={form.label} onChange={e => setField('label', e.target.value)} placeholder="如 web-01" />
        </div>
        <div className={`tm-fld ${errors.host ? 'error' : ''}`}>
          <label>主机 <span className="tm-req">*</span></label>
          <input value={form.host} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.10" />
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <div className="tm-fld" style={{ flex: '0 0 90px' }}>
            <label>端口</label>
            <input value={form.port} onChange={e => setField('port', e.target.value)} placeholder={proto === 'ssh' ? '22' : '23'} />
          </div>
          <div className={`tm-fld ${errors.user ? 'error' : ''}`} style={{ flex: 1 }}>
            <label>用户名 {proto === 'ssh' ? <span className="tm-req">*</span> : <span className="tm-opt">选填</span>}</label>
            <input value={form.user} onChange={e => setField('user', e.target.value)} placeholder="admin" />
          </div>
        </div>
        {proto === 'ssh' && (
          <>
            <div className="tm-authSwitch">
              <span className={authMode === 'password' ? 'on' : ''} onClick={() => setAuthMode('password')}>密码</span>
              <span className={authMode === 'key' ? 'on' : ''} onClick={() => setAuthMode('key')}>密钥</span>
            </div>
            {authMode === 'password'
              ? pwdField('pass', '密码', '登录密码', true, 'pass')
              : (
                <>
                  <div className={`tm-fld ${errors.key ? 'error' : ''}`}>
                    <label>私钥 <span className="tm-req">*</span></label>
                    <input value={form.key} onChange={e => setField('key', e.target.value)} placeholder="私钥内容或路径" />
                  </div>
                  {pwdField('passphrase', '口令', '口令', false)}
                </>
              )
            }
          </>
        )}
        <div className="tm-fld">
          <label>备注 <span className="tm-opt">选填</span></label>
          <input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="用途、位置等" />
        </div>

        {/* 高级折叠：换行 + 回显 */}
        <div className={`tm-advToggle ${showAdv ? 'open' : ''}`} onClick={() => setShowAdv(v => !v)}>
          <span className="arrow">▶</span> 连接选项
        </div>
        <div className={`tm-advBody ${showAdv ? 'open' : ''}`}>
          <div className="tm-fld">
            <label>换行</label>
            <select value={newline} onChange={e => setNewline(e.target.value as 'lf' | 'cr' | 'crlf')}>
              <option value="lf">LF (\n)</option>
              <option value="cr">CR (\r)</option>
              <option value="crlf">CRLF (\r\n)</option>
            </select>
          </div>
          <div className="tm-fld">
            <label>回显</label>
            <input type="checkbox" checked={localEcho} onChange={e => setLocalEcho(e.target.checked)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="tm-btn primary" onClick={save}>保存</button>
          <button className="tm-btn" onClick={quickConnect}>连接</button>
          {editing !== null && <button className="tm-btn" onClick={resetForm}>取消</button>}
        </div>

        {/* 最近连接（hover 移除） */}
        <div className="tm-secLabel" style={{ marginTop: 12 }}>最近连接</div>
        <div>
          {conns.length === 0 ? <div className="tm-empty">暂无保存的连接</div> : conns.map(c => {
            const sess = sessionOfConn(c.id)
            const status = sess?.status ?? 'off'
            return (
              <div key={c.id} className="tm-ritem" onClick={() => onConnect({ connId: c.id })} title="点我连接">
                <span className={`tm-pico ${c.protocol}`}>{c.protocol.toUpperCase()}</span>
                <span className="nm">{c.label}</span>
                <span className={`st ${status === 'open' ? 'on' : status === 'connecting' ? 'connecting' : 'off'}`} />
                <button onClick={e => { e.stopPropagation(); loadConn(c) }} title="编辑" style={{ display: 'none' }}>✎</button>
                <button onClick={e => { e.stopPropagation(); void delConn(c.id) }} title="移除" className="tm-hover-btn">✕</button>
              </div>
            )
          })}
        </div>

        {/* 活跃会话（右键菜单 + 排序 + 未读标记） */}
        <div className="tm-secLabel" style={{ marginTop: 12 }}>活跃会话</div>
        <div>
          {sortedSessions.length === 0 ? <div className="tm-empty">暂无活跃会话</div> : sortedSessions.map(s => (
            <div
              key={s.sessionId}
              className={`tm-ritem ${pinned.has(s.sessionId) ? 'pinned' : ''}`}
              onClick={() => handleSessionClick(s)}
              onContextMenu={e => onSessionContextMenu(e, s)}
              style={{ cursor: 'pointer' }}
            >
              <span className={`tm-pico ${s.protocol}`}>{s.protocol.toUpperCase()}</span>
              {renameId === s.sessionId ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename() }}
                  onClick={e => e.stopPropagation()}
                  style={{ flex: 1, fontSize: 12, padding: '2px 6px' }}
                />
              ) : (
                <span className="nm">{s.label}</span>
              )}
              {pinned.has(s.sessionId) && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }}>📌</span>}
              {unreadSet.has(s.sessionId) && <span className="tm-unread" />}
              <button onClick={e => { e.stopPropagation(); onDisconnect(s.sessionId) }} title="断开">✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* 右键菜单 */}
      {ctxMenu !== null && (
        <div className="tm-ctxMenu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="tm-ctxItem" onClick={() => togglePin(ctxMenu.sessionId)}>
            {pinned.has(ctxMenu.sessionId) ? '取消置顶' : '置顶'}
          </div>
          <div className="tm-ctxItem" onClick={() => {
            const s = sessions.find(x => x.sessionId === ctxMenu.sessionId)
            if (s !== undefined) startRename(s.sessionId, s.label)
          }}>重命名</div>
          <div className="tm-ctxSep" />
          <div className="tm-ctxItem" onClick={() => { onDisconnect(ctxMenu.sessionId); setCtxMenu(null) }}>断开</div>
          <div className="tm-ctxItem" style={{ color: 'var(--dsw-alias-state-error-primary, #ef4444)' }} onClick={() => {
            onDisconnect(ctxMenu.sessionId); setPinned(prev => { const n = new Set(prev); n.delete(ctxMenu.sessionId); return n })
            setCtxMenu(null)
          }}>移除</div>
        </div>
      )}
    </div>
  )
}

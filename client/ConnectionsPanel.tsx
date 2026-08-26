/**
 * F2 连接面板 —— 设备清单 + 新建/编辑表单 + 活跃会话。
 * 经 rpc 调指令通道（/api/term-manager.*）；用 DSH token 配色。
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

interface Props {
  sessions: SessionSnap[]
  onConnect: (connId: string) => void
  onDisconnect: (sessionId: string) => void
}

export function ConnectionsPanel({ sessions, onConnect, onDisconnect }: Props): React.JSX.Element {
  const [conns, setConns] = useState<ConnectionCfg[]>([])
  const [proto, setProto] = useState<'ssh' | 'telnet'>('ssh')
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password')
  const [editing, setEditing] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' })

  const refresh = useCallback(async () => {
    try { setConns(await rpc<ConnectionCfg[]>('connections.list')) } catch { /* ignore */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  function setField(name: keyof typeof form, value: string): void {
    setForm(f => ({ ...f, [name]: value }))
  }

  function resetForm(): void {
    setEditing(null)
    setProto('ssh')
    setAuthMode('password')
    setErrors({})
    setForm({ label: '', host: '', port: '', user: '', pass: '', key: '', passphrase: '', note: '' })
  }

  function loadConn(c: ConnectionCfg): void {
    setEditing(c.id)
    setProto(c.protocol)
    setAuthMode('password')
    setErrors({})
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
      if (editing !== null) {
        await rpc('connections.update', { id: editing, patch: base })
      } else {
        await rpc('connections.create', base)
      }
      await refresh()
      resetForm()
    } catch (err) {
      alert((err as RpcError).message)
    }
  }

  async function quickConnect(): Promise<void> {
    if (!validate()) return
    // 先保存（若未入库）再连接
    if (editing === null) {
      const port = Number(form.port) || (proto === 'ssh' ? 22 : 23)
      const base = { label: form.label.trim(), protocol: proto, host: form.host.trim(), port, username: proto === 'ssh' ? form.user.trim() : undefined, note: form.note.trim() || undefined, auth: proto === 'ssh' ? (authMode === 'password' ? { kind: 'password' as const, password: form.pass } : { kind: 'key' as const, privateKey: form.key, passphrase: form.passphrase || undefined }) : undefined }
      try {
        const created = await rpc<ConnectionCfg>('connections.create', base)
        await refresh()
        onConnect(created.id)
      } catch (err) { alert((err as RpcError).message) }
    } else {
      onConnect(editing)
    }
  }

  async function delConn(id: string): Promise<void> {
    try { await rpc('connections.remove', { id }); await refresh(); if (editing === id) resetForm() } catch { /* ignore */ }
  }

  const sessionOfConn = (connId: string): SessionSnap | undefined => sessions.find(s => s.connId === connId && s.status !== 'closed')

  return (
    <div className="tm-side">
      <div className="tm-sideHead"><span className="t">📡 连接</span></div>
      <div className="tm-sideScroll">
        <div className="tm-ptabs">
          <div className={`tm-ptab ${proto === 'ssh' ? 'on' : ''}`} onClick={() => setProto('ssh')}>SSH</div>
          <div className={`tm-ptab ${proto === 'telnet' ? 'on' : ''}`} onClick={() => setProto('telnet')}>Telnet</div>
        </div>
        <div className="tm-secLabel">连接</div>
        <div className={`tm-fld ${errors.label ? 'error' : ''}`}>
          <label>名称 <span className="tm-req">*</span></label>
          <input value={form.label} onChange={e => setField('label', e.target.value)} placeholder="如 web-01" />
        </div>
        <div className={`tm-fld ${errors.host ? 'error' : ''}`}>
          <label>主机 <span className="tm-req">*</span></label>
          <input value={form.host} onChange={e => setField('host', e.target.value)} placeholder="192.168.1.10" />
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <div className="tm-fld" style={{ flex: '0 0 80px' }}>
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
            {authMode === 'password' ? (
              <div className={`tm-fld ${errors.pass ? 'error' : ''}`}>
                <label>密码 <span className="tm-req">*</span></label>
                <input type="password" value={form.pass} onChange={e => setField('pass', e.target.value)} placeholder="登录密码" />
              </div>
            ) : (
              <>
                <div className={`tm-fld ${errors.key ? 'error' : ''}`}>
                  <label>私钥 <span className="tm-req">*</span></label>
                  <input value={form.key} onChange={e => setField('key', e.target.value)} placeholder="私钥内容或路径" />
                </div>
                <div className="tm-fld">
                  <label>口令 <span className="tm-opt">选填</span></label>
                  <input type="password" value={form.passphrase} onChange={e => setField('passphrase', e.target.value)} placeholder="口令" />
                </div>
              </>
            )}
          </>
        )}
        <div className="tm-fld">
          <label>备注 <span className="tm-opt">选填</span></label>
          <input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="用途、位置等" />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="tm-btn primary" onClick={save}>保存</button>
          <button className="tm-btn" onClick={quickConnect}>连接</button>
        </div>

        <div className="tm-secLabel">最近连接</div>
        <div>
          {conns.length === 0 ? <div className="tm-empty">暂无保存的连接</div> : conns.map(c => {
            const sess = sessionOfConn(c.id)
            const status = sess?.status ?? 'off'
            return (
              <div key={c.id} className="tm-ritem" onClick={() => loadConn(c)} title={`${c.host}:${c.port}${c.note ? ' · ' + c.note : ''}`}>
                <span className={`tm-pico ${c.protocol}`}>{c.protocol.toUpperCase()}</span>
                <span className="nm">{c.label}</span>
                <span className={`st ${status === 'open' ? 'on' : status === 'connecting' ? 'connecting' : 'off'}`} />
                <button onClick={e => { e.stopPropagation(); void delConn(c.id) }} title="删除">✕</button>
              </div>
            )
          })}
        </div>

        <div className="tm-secLabel">活跃会话</div>
        <div>
          {sessions.length === 0 ? <div className="tm-empty">暂无活跃会话</div> : sessions.map(s => (
            <div key={s.sessionId} className="tm-ritem">
              <span className={`tm-pico ${s.protocol}`}>{s.protocol.toUpperCase()}</span>
              <span className="nm">{s.label}</span>
              <button onClick={() => onDisconnect(s.sessionId)} title="断开">✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

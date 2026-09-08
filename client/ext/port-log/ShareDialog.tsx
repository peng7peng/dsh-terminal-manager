import { useEffect, useState } from 'react'
import { portLogRpc, subscribePortLogEvents } from './rpc.ts'
import { applyPortLogEvent, usePortLogState, type ClientShare } from './store.ts'

interface Props {
  sessionId: string
  label: string
  onClose: () => void
}

export function ShareDialog({ sessionId, label, onClose }: Props): React.JSX.Element {
  const { shares } = usePortLogState()
  const share = shares.find(s => s.sessionId === sessionId)
  const [sharePort, setSharePort] = useState('2323')
  const [maxClients, setMaxClients] = useState('0')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Subscribe to SSE events while dialog is open for real-time client count updates
  useEffect(() => subscribePortLogEvents(applyPortLogEvent, () => {}), [])

  async function start(): Promise<void> {
    setStarting(true)
    setError(null)
    try {
      const result = await portLogRpc<ClientShare>('shares.start', { sessionId, localAddr: '0.0.0.0', sharePort: Number(sharePort), maxClients: Number(maxClients), welcomeMessage: '' })
      applyPortLogEvent('share-status', result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动共享失败')
    } finally {
      setStarting(false)
    }
  }

  async function stop(): Promise<void> {
    setStopping(true)
    try {
      await portLogRpc('shares.stop', { sessionId })
      applyPortLogEvent('share-removed', { sessionId })
    } catch { /* */ }
    finally {
      setStopping(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <div style={{ width: 320, background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.2)', color: 'var(--dsw-alias-label-primary, #000)', font: '14px/1.5 var(--dsw-font-family, system-ui, sans-serif)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))' }}>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>共享终端 — {label}</span>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #666)', lineHeight: 1 }}>&times;</button>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {share ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ flex: 1, fontFamily: 'var(--dsw-font-code, monospace)', fontSize: 13, color: 'var(--dsw-alias-state-success-primary, #22c55e)', fontWeight: 600 }}>0.0.0.0:{share.sharePort}</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(34,197,94,.14)', color: 'var(--dsw-alias-state-success-primary, #15803d)', fontWeight: 700 }}>运行中</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 4 }}>已连接客户端：{share.clients.length}{share.maxClients > 0 ? ` / ${share.maxClients}` : ''}</div>
              {share.clients.map(c => (
                <div key={c.id} style={{ fontSize: 11, fontFamily: 'var(--dsw-font-code, monospace)', color: 'var(--dsw-alias-label-tertiary, #888)', paddingLeft: 8 }}>{c.remoteAddress}</div>
              ))}
              {share.lastError && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ef4444)', marginTop: 4 }}>{share.lastError}</div>}
              <button className="tm-btn" style={{ width: '100%', marginTop: 10, color: 'var(--dsw-alias-state-error-primary, #ef4444)' }} disabled={stopping} onClick={() => void stop()}>{stopping ? '停止中…' : '停止共享'}</button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 2 }}>端口</label>
                  <input type="number" min={1} max={65535} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: 'var(--dsw-font-code, monospace)', outline: 'none' }} value={sharePort} onChange={e => setSharePort(e.target.value)} />
                </div>
                <div style={{ flex: '0 0 70px' }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 2 }}>上限</label>
                  <input type="number" min={0} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 6, padding: '5px 8px', fontSize: 13, outline: 'none' }} value={maxClients} onChange={e => setMaxClients(e.target.value)} title="0 = 不限制" />
                </div>
              </div>
              {error && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ef4444)', marginBottom: 6 }}>{error}</div>}
              <button className="tm-btn primary" style={{ width: '100%', marginTop: 4 }} disabled={starting} onClick={() => void start()}>{starting ? '启动中…' : '开始共享'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { portLogRpc } from './rpc.ts'
import { canStartShare, type ClientSession, type ClientShare } from './store.ts'

interface Props { sessions: ClientSession[]; shares: ClientShare[]; refresh: () => Promise<void>; reportError: (error: unknown) => void }

export function SharesTab({ sessions, shares, refresh, reportError }: Props): React.JSX.Element {
  const open = useMemo(() => sessions.filter((session) => session.status === 'open'), [sessions])
  const [sessionId, setSessionId] = useState('')
  const [localAddr, setLocalAddr] = useState('0.0.0.0')
  const [sharePort, setSharePort] = useState('2323')
  const [maxClients, setMaxClients] = useState('0')
  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [riskConfirmed, setRiskConfirmed] = useState(false)

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!canStartShare(riskConfirmed)) return
    try {
      await portLogRpc('shares.start', { sessionId, localAddr, sharePort: Number(sharePort), maxClients: Number(maxClients), welcomeMessage })
      setRiskConfirmed(false)
      await refresh()
    } catch (error) { reportError(error) }
  }

  async function stop(id: string): Promise<void> {
    try { await portLogRpc('shares.stop', { sessionId: id }); await refresh() } catch (error) { reportError(error) }
  }

  return <section className="tm-ext-pl-section">
    <div className="tm-ext-pl-warning"><strong>高风险：无认证、完全可写。</strong>任何能连接该端口的客户端都可查看输出并控制终端，输入可能与本地操作或 AI 命令交错。</div>
    <form className="tm-ext-pl-form tm-ext-pl-share-form" onSubmit={(event) => void start(event)}>
      <select aria-label="共享会话" value={sessionId} onChange={(event) => setSessionId(event.target.value)} required><option value="">选择已打开会话</option>{open.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.label} · {session.target}</option>)}</select>
      <input aria-label="共享监听地址" value={localAddr} onChange={(event) => setLocalAddr(event.target.value)} required />
      <input aria-label="共享端口" type="number" min="1" max="65535" value={sharePort} onChange={(event) => setSharePort(event.target.value)} required />
      <input aria-label="客户端上限" type="number" min="0" max="10000" value={maxClients} onChange={(event) => setMaxClients(event.target.value)} title="0 表示不限制" />
      <input aria-label="欢迎语" maxLength={512} value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} placeholder="欢迎语（可选）" />
      <label className="tm-ext-pl-risk"><input type="checkbox" checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)} />我确认任何可访问者都能查看并控制该终端</label>
      <button className="tm-ext-pl-primary" type="submit" disabled={!canStartShare(riskConfirmed) || sessionId === ''}>开始共享</button>
    </form>
    <div className="tm-ext-pl-list">
      {shares.length === 0 && <p className="tm-ext-pl-empty">暂无会话共享</p>}
      {shares.map((share) => <article className="tm-ext-pl-card" key={share.sessionId}>
        <div className="tm-ext-pl-card-main"><strong>{share.localAddr}:{share.sharePort}</strong><span>会话 {share.sessionId.slice(0, 8)}</span></div>
        <span className={`tm-ext-pl-status is-${share.state}`}>{share.state}</span>
        <div className="tm-ext-pl-metrics">客户端 {share.clients.length}{share.maxClients > 0 ? ` / ${share.maxClients}` : '（不限）'}</div>
        {share.clients.map((client) => <div className="tm-ext-pl-client" key={client.id}>{client.remoteAddress} · ↑ {client.bytesFromClient} B · ↓ {client.bytesToClient} B</div>)}
        {share.lastError && <div className="tm-ext-pl-error">最近错误：{share.lastError}</div>}
        <div className="tm-ext-pl-actions"><button type="button" className="danger" onClick={() => void stop(share.sessionId)}>停止共享</button></div>
      </article>)}
    </div>
  </section>
}

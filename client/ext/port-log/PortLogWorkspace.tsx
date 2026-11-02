import { useCallback, useEffect, useState } from 'react'
import { LogsTab } from './LogsTab.tsx'
import { MappingsTab } from './MappingsTab.tsx'
import { SharesTab } from './SharesTab.tsx'
import { portLogRpc, subscribePortLogEvents } from './rpc.ts'
import {
  applyPortLogEvent, loadDefaultLogDirectory, setPortLogError, setPortLogLoading, setPortLogSnapshot,
  setPortLogVisible, usePortLogState,
  type ClientAppLog, type ClientMapping, type ClientSession, type ClientSessionLog, type ClientShare,
} from './store.ts'

export function PortLogWorkspace(): React.JSX.Element | null {
  const state = usePortLogState()
  const [tab, setTab] = useState<'mappings' | 'logs' | 'shares'>('mappings')

  const refresh = useCallback(async (): Promise<void> => {
    setPortLogLoading(true)
    try {
      const [mappings, sessions, shares, sessionLogs, appLog] = await Promise.all([
        portLogRpc<ClientMapping[]>('mappings.list'),
        portLogRpc<ClientSession[]>('sessions.list'),
        portLogRpc<ClientShare[]>('shares.list'),
        portLogRpc<ClientSessionLog[]>('sessionLogs.list'),
        portLogRpc<ClientAppLog>('appLogs.status'),
      ])
      setPortLogSnapshot({ mappings, sessions, shares, sessionLogs, appLog })
      setPortLogError(undefined)
    } catch (error) {
      setPortLogError(error instanceof Error ? error.message : '加载失败')
    } finally {
      setPortLogLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!state.visible) return
    void refresh()
    void loadDefaultLogDirectory().catch(() => { /* 连接面板可重试。 */ })
    return subscribePortLogEvents(applyPortLogEvent, () => void refresh())
  }, [state.visible, refresh])

  if (!state.visible) return null
  const reportError = (error: unknown): void => setPortLogError(error instanceof Error ? error.message : '操作失败')

  return <div className="tm-ext-pl-overlay" role="dialog" aria-label="端口映射工作区">
    <header className="tm-ext-pl-header">
      <div><h2>端口映射</h2><p>TCP/UDP 端口转发</p></div>
      <button type="button" className="tm-ext-pl-close" title="关闭端口映射" aria-label="关闭端口映射" onClick={() => setPortLogVisible(false)}>×</button>
    </header>
    {state.error && <div className="tm-ext-pl-global-error" role="alert">{state.error}<button type="button" onClick={() => setPortLogError(undefined)}>关闭</button></div>}
    {state.loading && <div className="tm-ext-pl-loading">正在同步运行状态…</div>}
    <nav className="tm-ext-pl-tabs" role="tablist" aria-label="端口映射工作区页签">
      <button type="button" role="tab" aria-selected={tab === 'mappings'} className={tab === 'mappings' ? 'is-active' : ''} onClick={() => setTab('mappings')}>端口映射</button>
      <button type="button" role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'is-active' : ''} onClick={() => setTab('logs')}>会话日志</button>
      <button type="button" role="tab" aria-selected={tab === 'shares'} className={tab === 'shares' ? 'is-active' : ''} onClick={() => setTab('shares')}>会话共享</button>
    </nav>
    <main className="tm-ext-pl-content">
      {tab === 'mappings' && <MappingsTab mappings={state.mappings} refresh={refresh} reportError={reportError} />}
      {tab === 'logs' && <LogsTab sessions={state.sessions} sessionLogs={state.sessionLogs} appLog={state.appLog} refresh={refresh} reportError={reportError} />}
      {tab === 'shares' && <SharesTab sessions={state.sessions} shares={state.shares} refresh={refresh} reportError={reportError} />}
    </main>
  </div>
}

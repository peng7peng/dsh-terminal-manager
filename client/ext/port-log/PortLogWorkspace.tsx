import { useCallback, useEffect, useState } from 'react'
import { LogsTab } from './LogsTab.tsx'
import { MappingsTab } from './MappingsTab.tsx'
import { portLogRpc, subscribePortLogEvents } from './rpc.ts'
import { SharesTab } from './SharesTab.tsx'
import {
  applyPortLogEvent, setPortLogError, setPortLogLoading, setPortLogSnapshot,
  setPortLogVisible, usePortLogState,
  type ClientAppLog, type ClientMapping, type ClientSession, type ClientSessionLog, type ClientShare,
} from './store.ts'

type Tab = 'mappings' | 'shares' | 'logs'

export function PortLogWorkspace(): React.JSX.Element | null {
  const state = usePortLogState()
  const [tab, setTab] = useState<Tab>('mappings')

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
    return subscribePortLogEvents(applyPortLogEvent, () => void refresh())
  }, [state.visible, refresh])

  if (!state.visible) return null
  const reportError = (error: unknown): void => setPortLogError(error instanceof Error ? error.message : '操作失败')

  return <div className="tm-ext-pl-overlay" role="dialog" aria-label="网络与日志工作区">
    <header className="tm-ext-pl-header">
      <div><h2>网络与日志</h2><p>端口映射 · 会话共享 · 输出日志</p></div>
      <button type="button" className="tm-ext-pl-close" title="关闭网络与日志" aria-label="关闭网络与日志" onClick={() => setPortLogVisible(false)}>×</button>
    </header>
    <nav className="tm-ext-pl-tabs" aria-label="网络与日志功能">
      <button type="button" className={tab === 'mappings' ? 'is-active' : ''} onClick={() => setTab('mappings')}>端口映射</button>
      <button type="button" className={tab === 'shares' ? 'is-active' : ''} onClick={() => setTab('shares')}>会话共享</button>
      <button type="button" className={tab === 'logs' ? 'is-active' : ''} onClick={() => setTab('logs')}>日志</button>
    </nav>
    {state.error && <div className="tm-ext-pl-global-error" role="alert">{state.error}<button type="button" onClick={() => setPortLogError(undefined)}>关闭</button></div>}
    {state.loading && <div className="tm-ext-pl-loading">正在同步运行状态…</div>}
    <main className="tm-ext-pl-content">
      {tab === 'mappings' && <MappingsTab mappings={state.mappings} refresh={refresh} reportError={reportError} />}
      {tab === 'shares' && <SharesTab sessions={state.sessions} shares={state.shares} refresh={refresh} reportError={reportError} />}
      {tab === 'logs' && <LogsTab sessions={state.sessions} sessionLogs={state.sessionLogs} appLog={state.appLog} refresh={refresh} reportError={reportError} />}
    </main>
  </div>
}

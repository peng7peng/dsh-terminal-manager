import { useCallback, useEffect } from 'react'
import { MappingsTab } from './MappingsTab.tsx'
import { portLogRpc, subscribePortLogEvents } from './rpc.ts'
import {
  applyPortLogEvent, loadDefaultLogDirectory, setPortLogError, setPortLogLoading, setPortLogSnapshot,
  setPortLogVisible, usePortLogState,
  type ClientAppLog, type ClientMapping, type ClientSession, type ClientSessionLog, type ClientShare,
} from './store.ts'

export function PortLogWorkspace(): React.JSX.Element | null {
  const state = usePortLogState()

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
    <main className="tm-ext-pl-content">
      <MappingsTab mappings={state.mappings} refresh={refresh} reportError={reportError} />
    </main>
  </div>
}

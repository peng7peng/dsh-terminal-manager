import { useState } from 'react'
import { portLogRpc } from './rpc.ts'
import type { ClientAppLog, ClientSession, ClientSessionLog } from './store.ts'

interface Props { sessions: ClientSession[]; sessionLogs: ClientSessionLog[]; appLog?: ClientAppLog; refresh: () => Promise<void>; reportError: (error: unknown) => void }

export function LogsTab({ sessions, sessionLogs, appLog, refresh, reportError }: Props): React.JSX.Element {
  const [timestamp, setTimestamp] = useState(true)
  const [stripAnsi, setStripAnsi] = useState(true)
  const active = new Map(sessionLogs.map((log) => [log.sessionId, log]))

  async function toggle(sessionId: string): Promise<void> {
    try {
      if (active.has(sessionId)) await portLogRpc('sessionLogs.stop', { sessionId })
      else await portLogRpc('sessionLogs.start', { sessionId, timestamp, stripAnsi })
      await refresh()
    } catch (error) { reportError(error) }
  }

  async function copy(path: string): Promise<void> {
    try { await navigator.clipboard.writeText(path) } catch (error) { reportError(error) }
  }

  return <section className="tm-ext-pl-section">
    <article className="tm-ext-pl-card tm-ext-pl-app-log">
      <div className="tm-ext-pl-card-main"><strong>插件运行日志 · {appLog?.level ?? 'info'}</strong><span>{appLog?.currentFile ?? '正在加载路径…'}</span></div>
      <div className="tm-ext-pl-metrics">5 MiB × 最多 5 个文件 · 当前 {appLog?.files.length ?? 0} 个文件</div>
      {appLog?.lastError && <div className="tm-ext-pl-error">{appLog.lastError}</div>}
      {appLog && <button type="button" title="复制应用日志路径" aria-label="复制应用日志路径" onClick={() => void copy(appLog.currentFile)}>复制路径</button>}
    </article>
    <div className="tm-ext-pl-warning"><strong>会话日志默认关闭且不会轮转。</strong>开启后文件会持续增长，直到会话关闭或手动停止；请关注磁盘占用。只直接记录设备输出，不记录用户或共享客户端输入。</div>
    <div className="tm-ext-pl-toolbar">
      <label className="tm-ext-pl-check"><input type="checkbox" checked={timestamp} onChange={(event) => setTimestamp(event.target.checked)} />新日志添加时间戳</label>
      <label className="tm-ext-pl-check"><input type="checkbox" checked={stripAnsi} onChange={(event) => setStripAnsi(event.target.checked)} />新日志清理 ANSI</label>
    </div>
    <div className="tm-ext-pl-list">
      {sessions.filter((session) => session.status === 'open').map((session) => {
        const log = active.get(session.sessionId)
        return <article className="tm-ext-pl-card" key={session.sessionId}>
          <div className="tm-ext-pl-card-main"><strong>{session.label}</strong><span>{session.target}</span></div>
          <span className={`tm-ext-pl-status is-${log?.state ?? 'stopped'}`}>{log?.state ?? 'stopped'}</span>
          {log && <><div className="tm-ext-pl-metrics">已写 {log.bytesWritten} B · 时间戳 {log.timestamp ? '开' : '关'} · ANSI 清理 {log.stripAnsi ? '开' : '关'}</div><div className="tm-ext-pl-path">{log.path}</div></>}
          {log?.lastError && <div className="tm-ext-pl-error">{log.lastError}</div>}
          <div className="tm-ext-pl-actions"><button type="button" onClick={() => void toggle(session.sessionId)}>{log ? '停止日志' : '开启日志'}</button>{log && <button type="button" title="复制会话日志路径" aria-label="复制会话日志路径" onClick={() => void copy(log.path)}>复制路径</button>}</div>
        </article>
      })}
    </div>
  </section>
}

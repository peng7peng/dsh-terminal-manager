/**
 * F4 终端组件 —— 单个 xterm.js 窗格。
 * @module dsh-terminal-manager/client/TermView
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ShareDialog } from './ext/port-log/ShareDialog.tsx'
import { portLogRpc } from './ext/port-log/rpc.ts'
import { applyPortLogEvent, usePortLogState, type ClientSessionLog } from './ext/port-log/store.ts'
import { IconSave16 } from './icons.tsx'
import { rpc } from './rpc.ts'
import { markUnread } from './store.ts'
import { toast } from './toast.ts'
import { parentDir } from './files/localFs.ts'
import type { TermWs } from './ws.ts'

interface TermViewProps {
  /** TC 编号（D1：在线会话顺序）；undefined = 不显示徽章 */
  tcIndex?: number
  sessionId: string
  connId?: string
  label: string
  target: string
  ws: TermWs
  onDisconnect: (sessionId: string) => void
  isHidden?: boolean
  isOpen: boolean
  isClosed?: boolean
  isMaximized?: boolean
  onToggleMaximize?: () => void
  onMinimize?: () => void
}

interface StoredLogConfig {
  timestamp: boolean
  stripAnsi: boolean
  directory?: string
}

interface StoredConnection {
  id: string
  log?: StoredLogConfig
}

export function TermView({ sessionId, connId, label, target, ws, onDisconnect, isHidden, isOpen, isClosed, isMaximized, onToggleMaximize, onMinimize, tcIndex }: TermViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Term | undefined>(undefined)
  const hiddenRef = useRef(isHidden)
  hiddenRef.current = isHidden
  const [showShare, setShowShare] = useState(false)
  const [logPending, setLogPending] = useState(false)
  const [autoStartingLog, setAutoStartingLog] = useState(isOpen)
  const [logging, setLogging] = useState(isOpen)
  const [logError, setLogError] = useState<string | undefined>()
  const { shares, sessionLogs } = usePortLogState()
  const currentLog = sessionLogs.find(log => log.sessionId === sessionId)
  const activeShare = shares.find(s => s.sessionId === sessionId)
  const sharing = activeShare !== undefined

  async function openLogFile(): Promise<void> {
    if (!isOpen || currentLog?.state !== 'running' || !currentLog.path) return
    try {
      await rpc('files.open', { root: parentDir(currentLog.path), path: currentLog.path })
    } catch (error) {
      toast(`打开日志失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
    }
  }

  useEffect(() => {
    if (autoStartingLog || logPending) return
    setLogging(currentLog?.state === 'running')
    if (currentLog?.state === 'running') setLogError(undefined)
    else if (currentLog?.lastError) setLogError(currentLog.lastError)
  }, [currentLog, autoStartingLog, logPending])

  async function loadLogConfig(): Promise<StoredLogConfig> {
    if (connId === undefined) return { timestamp: true, stripAnsi: true }
    try {
      const connections = await rpc<StoredConnection[]>('connections.list')
      return connections.find(connection => connection.id === connId)?.log ?? { timestamp: true, stripAnsi: true }
    } catch {
      return { timestamp: true, stripAnsi: true }
    }
  }

  async function startLog(): Promise<ClientSessionLog> {
    const config = await loadLogConfig()
    const started = await portLogRpc<ClientSessionLog>('sessionLogs.start', {
      sessionId,
      timestamp: config.timestamp,
      stripAnsi: config.stripAnsi,
      ...(config.directory?.trim() ? { directory: config.directory.trim() } : {}),
    })
    applyPortLogEvent('session-log-status', started)
    return started
  }

  async function toggleLog(): Promise<void> {
    if (!isOpen || logPending || autoStartingLog) return
    setLogPending(true)
    setLogError(undefined)
    try {
      if (logging) {
        await portLogRpc('sessionLogs.stop', { sessionId })
        applyPortLogEvent('session-log-status', { sessionId, state: 'stopped' })
        setLogging(false)
      } else {
        await startLog()
        setLogging(true)
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '存盘操作失败')
      try {
        const logs = await portLogRpc<ClientSessionLog[]>('sessionLogs.list')
        const current = logs.find(log => log.sessionId === sessionId)
        applyPortLogEvent('session-log-status', current ?? { sessionId, state: 'stopped' })
        setLogging(current?.state === 'running')
      } catch { /* 保留当前状态，下一次操作继续重试。 */ }
    } finally {
      setLogPending(false)
    }
  }

  useEffect(() => {
    // connecting 也未就绪；必须在 false → true 时重新执行启动。
    if (!isOpen) {
      setAutoStartingLog(false)
      setLogging(false)
      applyPortLogEvent('session-log-status', { sessionId, state: 'stopped' })
      return
    }
    let cancelled = false
    setAutoStartingLog(true)
    setLogging(true)
    setLogError(undefined)
    void (async () => {
      try {
        const started = await startLog()
        if (cancelled) return
        applyPortLogEvent('session-log-status', started)
        setLogging(true)
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        const reportFailure = (): void => {
          if (cancelled) return
          setLogError(message)
          toast(`${label} 自动存盘失败：${message}`, 'error', 10000)
        }
        // 可能与另一个启动入口并发；重新读取服务端状态作为最终结果。
        try {
          const logs = await portLogRpc<ClientSessionLog[]>('sessionLogs.list')
          const current = logs.find(log => log.sessionId === sessionId)
          if (!cancelled) {
            applyPortLogEvent('session-log-status', current ?? { sessionId, state: 'stopped' })
            setLogging(current?.state === 'running')
            if (current?.state !== 'running') reportFailure()
          }
        } catch {
          if (!cancelled) setLogging(false)
          reportFailure()
        }
      } finally {
        if (!cancelled) setAutoStartingLog(false)
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, connId, isOpen])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const DARK_THEME = { background: '#0b0e14', foreground: '#d8dee9', cursor: '#e6c07b', cursorAccent: '#0b0e14', selectionBackground: '#58a6ff44' }
    const LIGHT_THEME = { background: '#ffffff', foreground: '#24292f', cursor: '#4170e6', cursorAccent: '#ffffff', selectionBackground: '#4170e633' }
    const term = new Terminal({ fontSize: 13, fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace', cursorBlink: true, scrollback: 5000, theme: document.body.hasAttribute('data-ds-dark-theme') ? DARK_THEME : LIGHT_THEME })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    try { fit.fit() } catch { /* 尺寸尚未就绪 */ }

    const unsub = ws.onOutput(sessionId, data => {
      try { term.write(data) } catch { /* 已销毁 */ }
      if (hiddenRef.current) markUnread(sessionId)
    })
    term.onData(data => ws.input(sessionId, data))

    const fallbackCopy = (text: string): void => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const sel = term.getSelection()
      if (sel !== undefined && sel.length > 0) fallbackCopy(sel)
    }
    container.addEventListener('mouseup', onMouseUp)
    const pasteFromClipboard = (): void => {
      if (navigator.clipboard?.readText !== undefined) {
        navigator.clipboard.readText().then(text => { if (text.length > 0) ws.input(sessionId, text) }).catch(() => {})
      }
    }
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      const ctrl = event.ctrlKey
      const meta = event.metaKey
      const shift = event.shiftKey
      // 拦截退格/删除：手动发送给服务器，不让 xterm 本地移动光标（设备会做退格钳制）
      if (key === 'backspace') {
        ws.input(sessionId, '\x7f') // DEL 字符
        return false // 阻止 xterm 默认行为
      }
      if (key === 'delete') {
        ws.input(sessionId, '\x1b[3~') // xterm 删除序列
        return false
      }
      if ((meta && key === 'c') || (ctrl && shift && key === 'c')) {
        event.preventDefault()
        const sel = term.getSelection()
        if (sel !== undefined && sel.length > 0) fallbackCopy(sel)
        return false
      }
      if (ctrl && !shift && !meta && key === 'c') {
        const sel = term.getSelection()
        if (sel !== undefined && sel.length > 0) { fallbackCopy(sel); return false }
        return true
      }
      if ((meta && key === 'v') || (ctrl && shift && key === 'v') || (ctrl && !shift && !meta && key === 'v')) {
        event.preventDefault()
        pasteFromClipboard()
        return false
      }
      return true
    })
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel !== undefined && sel.length > 0) {
        fallbackCopy(sel)
        term.clearSelection()
      } else {
        pasteFromClipboard()
      }
    }
    container.addEventListener('contextmenu', onContext)

    async function loadHistory(): Promise<void> {
      try {
        const page = await rpc<{ text: string; totalLines: number; truncated: boolean }>('sessions.read', { sessionId })
        if (page.text.length > 0) term.write(page.text + (page.truncated ? '\r\n[历史已截断]\r\n' : ''))
      } catch { /* 会话已断 */ }
    }
    void loadHistory()

    // 布局抖动期间（拖文件面板顶栏 / 拖聊天宽度 / 改列数）ResizeObserver 每帧都触发：
    // 停稳后再把尺寸同步给设备。高频 resize 会把弱 telnetd 打糊涂（NAWS 协商字节被当输入回显成乱码）。
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const cols = term.cols, rows = term.rows
        if (Number.isFinite(cols) && Number.isFinite(rows)) ws.resize(sessionId, cols, rows)
      }, 150)
    })
    ro.observe(container)
    ws.resize(sessionId, term.cols, term.rows)

    const updateTheme = (): void => {
      term.options.theme = document.body.hasAttribute('data-ds-dark-theme') ? DARK_THEME : LIGHT_THEME
    }
    const themeMo = new MutationObserver(updateTheme)
    themeMo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    return () => {
      unsub()
      clearTimeout(resizeTimer)
      ro.disconnect()
      themeMo.disconnect()
      container.removeEventListener('contextmenu', onContext)
      container.removeEventListener('mouseup', onMouseUp)
      term.dispose()
      termRef.current = undefined
    }
  }, [sessionId, ws])

  return (
    <div className={`tm-pane ${isClosed ? 'tm-pane-closed' : ''} ${isMaximized ? 'tm-pane-maximized' : ''}`}>
      <div className="tm-paneBar">
        <span className="dot" />
        <span className="nm">{label}</span>
        {tcIndex !== undefined && <span className="tm-tcn" title="活跃会话列表顺序（拖动列表即切换）">{tcIndex}</span>}
        <span className="tgt">{target}</span>
        {!isClosed && <button type="button" className={`tm-saveBtn ${logging ? 'is-on' : 'is-off'}`} disabled={!isOpen || logPending || autoStartingLog} aria-pressed={logging} aria-label={logging ? '停止存盘' : '开始存盘'} title={logError ? `存盘失败：${logError}；点击重试` : !isOpen ? '等待连接后自动存盘' : logging ? '停止存盘' : '开始存盘'} onClick={() => { void toggleLog() }}><IconSave16 size={13} /></button>}
        {!isClosed && <button onClick={() => setShowShare(true)} title={activeShare === undefined ? '共享此终端' : `共享端口：${activeShare.sharePort}`} style={{ color: sharing ? 'var(--dsw-alias-state-success-primary, #22c55e)' : undefined }}>{sharing ? '🔓' : '🔒'}</button>}
        {isClosed ? (
          <>
            <span className="tm-closed-label">已断开</span>
            <button onClick={() => onDisconnect(sessionId)} title="关闭">✕</button>
          </>
        ) : (
          <>
            <button onClick={onMinimize} title="最小化">🗕</button>
            {isMaximized ? (
              <button onClick={onToggleMaximize} title="还原">🗗</button>
            ) : (
              <button onClick={onToggleMaximize} title="最大化">🗖</button>
            )}
            <button onClick={() => onDisconnect(sessionId)} title="断开">✕</button>
          </>
        )}
      </div>
      <div className="tm-paneBody" ref={containerRef} />
      {isOpen && currentLog?.state === 'running' && currentLog.path && <div
        className="tm-logPath"
        role="button"
        tabIndex={0}
        aria-label={`打开日志文件：${currentLog.path}`}
        title={`${currentLog.path}\n双击打开日志文件`}
        onDoubleClick={() => { void openLogFile() }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            void openLogFile()
          }
        }}
      >{currentLog.path}</div>}
      {showShare && <ShareDialog sessionId={sessionId} label={label} onClose={() => setShowShare(false)} />}
    </div>
  )
}

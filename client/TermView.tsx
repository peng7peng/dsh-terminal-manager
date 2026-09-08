/**
 * F4 终端组件 —— 单个 xterm.js 窗格。
 * @module dsh-terminal-manager/client/TermView
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ShareDialog } from './ext/port-log/ShareDialog.tsx'
import { usePortLogState } from './ext/port-log/store.ts'
import { rpc } from './rpc.ts'
import { markUnread } from './store.ts'
import type { TermWs } from './ws.ts'

interface TermViewProps {
  /** TC 编号（D1：在线会话顺序）；undefined = 不显示徽章 */
  tcIndex?: number
  sessionId: string
  label: string
  target: string
  ws: TermWs
  onDisconnect: (sessionId: string) => void
  isHidden?: boolean
  isClosed?: boolean
  isMaximized?: boolean
  onToggleMaximize?: () => void
  onMinimize?: () => void
}

export function TermView({ sessionId, label, target, ws, onDisconnect, isHidden, isClosed, isMaximized, onToggleMaximize, onMinimize, tcIndex }: TermViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Term | undefined>(undefined)
  const hiddenRef = useRef(isHidden)
  hiddenRef.current = isHidden
  const [showShare, setShowShare] = useState(false)
  const { shares } = usePortLogState()
  const sharing = shares.some(s => s.sessionId === sessionId)

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
        {tcIndex !== undefined && <span className="tm-tcn" title="TC 编号 = 活跃会话列表顺序（拖动列表即切换）">TC{tcIndex}</span>}
        <span className="tgt">{target}</span>
        {!isClosed && <button onClick={() => setShowShare(true)} title="共享此终端" style={{ color: sharing ? 'var(--dsw-alias-state-success-primary, #22c55e)' : undefined }}>{sharing ? '🔓' : '🔒'}</button>}
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
      {showShare && <ShareDialog sessionId={sessionId} label={label} onClose={() => setShowShare(false)} />}
    </div>
  )
}

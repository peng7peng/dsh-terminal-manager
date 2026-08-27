/**
 * F4 终端组件 —— 单个 xterm.js 窗格。
 *
 * 挂载时：创建 Terminal + FitAddon，附着到会话（ws.onOutput 写入，term.onData 发出），
 * 调 sessions.read 拉历史缓冲回填，ResizeObserver 随尺寸调 ws.resize。
 * @module dsh-terminal-manager/client/TermView
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { rpc } from './rpc.ts'
import type { TermWs } from './ws.ts'

interface TermViewProps {
  sessionId: string
  label: string
  target: string
  ws: TermWs
  onDisconnect: (sessionId: string) => void
}

export function TermView({ sessionId, label, target, ws, onDisconnect }: TermViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Term | undefined>(undefined)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    // 根据 DSH 主题选终端配色
    const DARK_THEME = { background: '#0b0e14', foreground: '#d8dee9', cursor: '#e6c07b', cursorAccent: '#0b0e14', selectionBackground: '#58a6ff44' }
    const LIGHT_THEME = { background: '#ffffff', foreground: '#24292f', cursor: '#4170e6', cursorAccent: '#ffffff', selectionBackground: '#4170e633' }
    const term = new Terminal({ fontSize: 13, fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace', cursorBlink: true, scrollback: 5000, theme: document.body.hasAttribute('data-ds-dark-theme') ? DARK_THEME : LIGHT_THEME })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    try { fit.fit() } catch { /* 尺寸尚未就绪 */ }

    // 附着：输出写入终端；键盘输入发往后端
    const unsub = ws.onOutput(sessionId, data => { try { term.write(data) } catch { /* 已销毁 */ } })
    term.onData(data => ws.input(sessionId, data))

    // ─── 复制粘贴（全快捷键覆盖 + PuTTY 式选中即复制 + 右键粘贴）───
    const isMac = navigator.platform.toLowerCase().includes('mac')
    const copyToClipboard = (text: string): void => {
      // 用 fallbackCopy（隐藏 textarea + execCommand）而非 navigator.clipboard.writeText——
      // 后者在某些浏览器（Edge）写剪贴板时会自动粘进当前焦点元素（xterm 隐藏 textarea → onData → 粘贴到设备）
      fallbackCopy(text)
    }
    const fallbackCopy = (text: string): void => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    const pasteFromClipboard = (): void => {
      if (navigator.clipboard?.readText !== undefined) {
        navigator.clipboard.readText().then(text => { if (text.length > 0) ws.input(sessionId, text) }).catch(() => {})
      }
    }
    // 选中即复制：暂时禁用——xterm 内部在 mouseup 时触发了 onData 导致同时粘贴，
    // 根因待查；先用 Ctrl+C / Ctrl+Shift+C / Cmd+C 复制（已验证正常）
    // const onMouseUp = ...
    // container.addEventListener('mouseup', onMouseUp)
    // 快捷键拦截
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      const ctrl = event.ctrlKey
      const meta = event.metaKey
      const shift = event.shiftKey
      // 复制：Cmd+C(Mac) / Ctrl+Shift+C(Win/Linux) / Ctrl+C(有选区→复制，无选区→SIGINT)
      if ((meta && key === 'c') || (ctrl && shift && key === 'c')) {
        event.preventDefault()  // 阻止浏览器抢快捷键（如 Edge DevTools）
        const sel = term.getSelection()
        if (sel !== undefined && sel.length > 0) copyToClipboard(sel)
        return false
      }
      if (ctrl && !shift && !meta && key === 'c') {
        const sel = term.getSelection()
        if (sel !== undefined && sel.length > 0) { copyToClipboard(sel); return false }
        return true // 无选区→SIGINT 传设备
      }
      // 粘贴：Cmd+V(Mac) / Ctrl+Shift+V(Win/Linux) / Ctrl+V
      if ((meta && key === 'v') || (ctrl && shift && key === 'v') || (ctrl && !shift && !meta && key === 'v')) {
        event.preventDefault()
        pasteFromClipboard()
        return false
      }
      return true
    })
    // 右键：有选区→复制；无选区→粘贴（PuTTY 模型，避免同时复制+粘贴）
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel !== undefined && sel.length > 0) {
        copyToClipboard(sel)
        term.clearSelection()
      } else {
        pasteFromClipboard()
      }
    }
    container.addEventListener('contextmenu', onContext)

    // 回填历史缓冲
    async function loadHistory(): Promise<void> {
      try {
        const page = await rpc<{ text: string; totalLines: number; truncated: boolean }>('sessions.read', { sessionId })
        if (page.text.length > 0) term.write(page.text + (page.truncated ? '\r\n[历史已截断]\r\n' : ''))
      } catch { /* 会话可能已断 */ }
    }
    void loadHistory()

    // 尺寸变化 → fit + 通知后端
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* ignore */ }
      const cols = term.cols, rows = term.rows
      if (Number.isFinite(cols) && Number.isFinite(rows)) ws.resize(sessionId, cols, rows)
    })
    ro.observe(container)
    ws.resize(sessionId, term.cols, term.rows)

    // 主题切换：DSH 切明暗时更新 xterm 配色
    const updateTheme = (): void => {
      term.options.theme = document.body.hasAttribute('data-ds-dark-theme') ? DARK_THEME : LIGHT_THEME
    }
    const themeMo = new MutationObserver(updateTheme)
    themeMo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    return () => {
      unsub()
      ro.disconnect()
      themeMo.disconnect()
      container.removeEventListener('contextmenu', onContext)
      term.dispose()
      termRef.current = undefined
    }
  }, [sessionId, ws])

  return (
    <div className="tm-pane">
      <div className="tm-paneBar">
        <span className="dot" />
        <span className="nm">{label}</span>
        <span className="tgt">{target}</span>
        <button onClick={() => onDisconnect(sessionId)} title="断开">✕</button>
      </div>
      <div className="tm-paneBody" ref={containerRef} />
    </div>
  )
}

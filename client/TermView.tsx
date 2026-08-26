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
    const term = new Terminal({ fontSize: 12, cursorBlink: true, scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    try { fit.fit() } catch { /* 尺寸尚未就绪 */ }

    // 附着：输出写入终端；键盘输入发往后端
    const unsub = ws.onOutput(sessionId, data => { try { term.write(data) } catch { /* 已销毁 */ } })
    term.onData(data => ws.input(sessionId, data))

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
    // 初始尺寸通知一次
    ws.resize(sessionId, term.cols, term.rows)

    return () => {
      unsub()
      ro.disconnect()
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

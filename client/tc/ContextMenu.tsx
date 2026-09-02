/**
 * 通用右键菜单（编辑器内用）。点击外部 / Esc 关闭。
 * @module dsh-terminal-manager/client/tc/ContextMenu
 */

import { useEffect } from 'react'

export interface CtxItem {
  id: string
  label: string
  kind?: 'go' | 'send' | 'plain' | 'sep'
  disabled?: boolean
  title?: string
}

export function ContextMenu(props: { x: number; y: number; items: CtxItem[]; onSelect: (id: string) => void; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (!(e.target instanceof Element) || e.target.closest('.tm-ctx') === null) props.onClose() }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [props])
  const left = typeof window === 'undefined' ? props.x : Math.min(props.x, window.innerWidth - 220)
  const top = typeof window === 'undefined' ? props.y : Math.min(props.y, window.innerHeight - 40 * props.items.length)
  return (
    <div className="tm-ctx" style={{ left, top }}>
      {props.items.map((it, i) => it.kind === 'sep'
        ? <div key={`sep-${i}`} className="tm-ctxSep" />
        : (
          <div
            key={it.id}
            className={`tm-ctxIt ${it.kind ?? ''} ${it.disabled ? 'dis' : ''}`}
            title={it.title}
            onClick={() => { if (!it.disabled) { props.onSelect(it.id); props.onClose() } }}
          >
            {it.label}
          </div>
        ))}
    </div>
  )
}

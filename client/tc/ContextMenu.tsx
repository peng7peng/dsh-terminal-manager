/**
 * 通用右键菜单（编辑器内用）。点击外部 / Esc 关闭。支持子菜单（hover 展开）。
 * @module dsh-terminal-manager/client/tc/ContextMenu
 */

import { useEffect, useState } from 'react'

export interface CtxItem {
  id: string
  label: string
  kind?: 'go' | 'send' | 'plain' | 'sep'
  disabled?: boolean
  title?: string
  submenu?: CtxItem[]
}

export function ContextMenu(props: { x: number; y: number; items: CtxItem[]; onSelect: (id: string) => void; onClose: () => void }): React.JSX.Element {
  const { onClose } = props
  const [subId, setSubId] = useState<string | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (!(e.target instanceof Element) || e.target.closest('.tm-ctx') === null) onClose() }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = typeof window === 'undefined' ? props.x : Math.min(props.x, window.innerWidth - 220)
  const top = typeof window === 'undefined' ? props.y : Math.min(props.y, window.innerHeight - 40 * props.items.length)
  return (
    <div className="tm-ctx" style={{ left, top }}>
      {props.items.map((it, i) => it.kind === 'sep'
        ? <div key={`sep-${i}`} className="tm-ctxSep" />
        : (
          <div
            key={it.id}
            className={`tm-ctxIt ${it.kind ?? ''} ${it.disabled ? 'dis' : ''} ${it.submenu ? 'has-sub' : ''}`}
            title={it.title}
            onMouseEnter={() => setSubId(it.submenu ? it.id : null)}
            onClick={() => { if (!it.disabled && !it.submenu) { props.onSelect(it.id); props.onClose() } }}
          >
            <span>{it.label}</span>
            {it.submenu && <span className="tm-ctxArrow">▶</span>}
            {it.submenu && subId === it.id && (
              <div className="tm-ctxSub">
                {it.submenu.map(sub => (
                  <div
                    key={sub.id}
                    className={`tm-ctxIt ${sub.kind ?? ''} ${sub.disabled ? 'dis' : ''}`}
                    title={sub.title}
                    onClick={(e) => { e.stopPropagation(); if (!sub.disabled) { props.onSelect(sub.id); props.onClose() } }}
                  >
                    <span>{sub.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  )
}

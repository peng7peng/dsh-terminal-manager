/**
 * 工作区可见性 store —— 侧边栏按钮与覆盖层共享开/关状态。
 * 模块级简易 observable，useSyncExternalStore 消费。
 * @module dsh-terminal-manager/client/store
 */

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

let visible = false
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

export function setWorkspaceVisible(v: boolean): void {
  if (visible === v) return
  visible = v
  emit()
}

export function toggleWorkspace(): void { setWorkspaceVisible(!visible) }

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): boolean { return visible }

export function useWorkspaceVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 聊天列宽度（px），可拖动调整（v4：默认 460，范围 300–760）。 */
const MIN_CHAT = 300, MAX_CHAT = 760, DEFAULT_CHAT = 460
let chatWidth = DEFAULT_CHAT
const chatListeners = new Set<() => void>()
export function setChatWidth(w: number): void {
  const clamped = Math.max(MIN_CHAT, Math.min(MAX_CHAT, w))
  if (chatWidth === clamped) return
  chatWidth = clamped
  chatListeners.forEach(l => l())
}
export function useChatWidth(): number {
  return useSyncExternalStore(
    (cb) => { chatListeners.add(cb); return () => { chatListeners.delete(cb) } },
    () => chatWidth,
  )
}

/** 找 DSH 真实 frame（overlayLayer 的父元素）。 */
function findFrame(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const overlay = document.querySelector('[data-shell-overlay]')
  return (overlay?.parentElement as HTMLElement) ?? null
}

/**
 * 工作区激活时强制 frame 网格成 `sidebar chatWidth 1fr`（聊天固定宽、终端填满右侧）。
 * 返回终端区（第三列）的位置和宽度，供覆盖层精确定位。
 * 用 inline style + MutationObserver 防 DSH 重渲染冲掉。
 */
export function useFrameLayout(active: boolean, chat: number): { left: number; width: number } {
  const [rect, setRect] = useState<{ left: number; width: number }>({ left: 0, width: 0 })
  useLayoutEffect(() => {
    if (!active) { setRect({ left: 0, width: 0 }); return }
    const frame = findFrame()
    if (frame === null) return
    let cancelled = false
    const apply = (): void => {
      if (cancelled) return
      const sidebar = (frame.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
      const target = `${sidebar}px ${chat}px 1fr`
      if (frame.style.gridTemplateColumns !== target) frame.style.gridTemplateColumns = target
      const details = frame.children[2] as HTMLElement | undefined
      if (details !== undefined) {
        const r = details.getBoundingClientRect()
        setRect(prev => (prev.left === r.left && prev.width === r.width ? prev : { left: r.left, width: r.width }))
      }
    }
    apply()
    const mo = new MutationObserver(apply)
    mo.observe(frame, { attributes: true, attributeFilter: ['style', 'class'], childList: true })
    window.addEventListener('resize', apply)
    return () => {
      cancelled = true
      mo.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [active, chat])
  return rect
}

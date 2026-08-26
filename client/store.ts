/**
 * 工作区可见性 store —— 侧边栏按钮与覆盖层共享开/关状态。
 * 模块级简易 observable，useSyncExternalStore 消费。
 * @module dsh-terminal-manager/client/store
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

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
 * 工作区激活时强制 frame 网格成 `sidebar chatWidth 0px`——把详情列压成 0 宽
 *（避免 ui-conversation 的 DetailsPanel 冒出来），聊天固定宽、终端覆盖层占右侧空白。
 * 关闭时还原 DSH 原值，聊天恢复 1fr。
 * 返回终端区左边界（= sidebar + chat），供覆盖层定位。
 *
 * 性能：用 rAF 合批 apply（每帧最多一次），MutationObserver 只盯 style 被 DSH 覆盖，
 * ResizeObserver 盯侧边栏宽度变化（收起/展开）；避免每次样式变更都强制 reflow。
 */
export function useFrameLayout(active: boolean, chat: number): number {
  const [left, setLeft] = useState(0)
  const originalRef = useRef<string | undefined>(undefined)
  const frameRef = useRef<HTMLElement | null>(null)
  const chatRef = useRef(chat)
  chatRef.current = chat

  useEffect(() => {
    if (!active) {
      const frame = frameRef.current
      if (frame !== null && originalRef.current !== undefined) {
        frame.style.gridTemplateColumns = originalRef.current
        originalRef.current = undefined
      }
      frameRef.current = null
      setLeft(0)
      return
    }
    const frame = findFrame()
    if (frame === null) return
    frameRef.current = frame
    if (originalRef.current === undefined) originalRef.current = frame.style.gridTemplateColumns

    let raf = 0
    const apply = (): void => {
      raf = 0
      const f = frameRef.current
      if (f === null) return
      const sidebar = (f.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
      const target = `${sidebar}px ${chatRef.current}px 0px`
      if (f.style.gridTemplateColumns !== target) f.style.gridTemplateColumns = target
      const next = sidebar + chatRef.current
      setLeft(prev => (prev === next ? prev : next))
    }
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(apply)
    }

    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(frame, { attributes: true, attributeFilter: ['style'] })
    const sidebar = frame.children[0] as HTMLElement | undefined
    const ro = new ResizeObserver(schedule)
    if (sidebar !== undefined) ro.observe(sidebar)
    window.addEventListener('resize', schedule)
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    const frame = frameRef.current
    if (frame === null) return
    const sidebar = (frame.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
    const target = `${sidebar}px ${chat}px 0px`
    if (frame.style.gridTemplateColumns !== target) frame.style.gridTemplateColumns = target
    const next = sidebar + chat
    setLeft(prev => (prev === next ? prev : next))
  }, [active, chat])

  return left
}

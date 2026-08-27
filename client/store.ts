/**
 * 工作区可见性 store —— 侧边栏按钮与覆盖层共享开/关状态。
 * 模块级简易 observable，useSyncExternalStore 消费。
 * @module dsh-terminal-manager/client/store
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

let visible = false
const listeners = new Set<() => void>()
let originalGrid: string | undefined  // DSH frame 原始 gridTemplateColumns

function emit(): void { for (const l of listeners) l() }

/** 找 DSH 真实 frame（overlayLayer 的父元素）。 */
function findFrame(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const overlay = document.querySelector('[data-shell-overlay]')
  return (overlay?.parentElement as HTMLElement) ?? null
}

export function setWorkspaceVisible(v: boolean): void {
  if (visible === v) return
  const frame = findFrame()
  if (v) {
    // 激活前捕获 DSH 原始 grid（只捕获一次）
    if (frame !== null && originalGrid === undefined) {
      originalGrid = frame.style.gridTemplateColumns
    }
  } else {
    // 关闭时同步还原（不依赖 React effect 时序）
    if (frame !== null && originalGrid !== undefined) {
      frame.style.gridTemplateColumns = originalGrid
      originalGrid = undefined
    }
  }
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
 * 工作区激活时强制 frame 网格成 `sidebar chatWidth 0px`。
 * capture/restore 在 setWorkspaceVisible 里（同步），这里只管强制 + 观察。
 */
export function useFrameLayout(active: boolean, chat: number): number {
  const [left, setLeft] = useState(0)
  const chatRef = useRef(chat)
  chatRef.current = chat

  useEffect(() => {
    if (!active) { setLeft(0); return }
    const frame = findFrame()
    if (frame === null) return

    let raf = 0
    const apply = (): void => {
      raf = 0
      const sidebar = (frame.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
      const target = `${sidebar}px ${chatRef.current}px 0px`
      if (frame.style.gridTemplateColumns !== target) frame.style.gridTemplateColumns = target
      setLeft(prev => { const n = sidebar + chatRef.current; return prev === n ? prev : n })
    }
    const schedule = (): void => { if (raf === 0) raf = requestAnimationFrame(apply) }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(frame, { attributes: true, attributeFilter: ['style'] })
    const ro = new ResizeObserver(schedule)
    const sidebar = frame.children[0] as HTMLElement | undefined
    if (sidebar !== undefined) ro.observe(sidebar)
    window.addEventListener('resize', schedule)
    return () => { if (raf !== 0) cancelAnimationFrame(raf); mo.disconnect(); ro.disconnect(); window.removeEventListener('resize', schedule) }
  }, [active])

  useEffect(() => {
    if (!active) return
    const frame = findFrame()
    if (frame === null) return
    const sidebar = (frame.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
    const target = `${sidebar}px ${chat}px 0px`
    if (frame.style.gridTemplateColumns !== target) frame.style.gridTemplateColumns = target
    setLeft(prev => { const n = sidebar + chat; return prev === n ? prev : n })
  }, [active, chat])

  return left
}

// ─── 未读标记（终端有新输出时会话条目显示蓝色圆点）───
const unreadSet = new Set<string>()
const unreadListeners = new Set<() => void>()

export function markUnread(sessionId: string): void {
  if (unreadSet.has(sessionId)) return
  unreadSet.add(sessionId)
  unreadListeners.forEach(l => l())
}

export function markRead(sessionId: string): void {
  if (!unreadSet.has(sessionId)) return
  unreadSet.delete(sessionId)
  unreadListeners.forEach(l => l())
}

export function useUnread(): Set<string> {
  return useSyncExternalStore(
    (cb) => { unreadListeners.add(cb); return () => { unreadListeners.delete(cb) } },
    () => unreadSet,
  )
}

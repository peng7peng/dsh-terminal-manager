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

/** 测试用：获取当前工作区可见性状态 */
export function getWorkspaceVisible(): boolean { return visible }

/** 测试用：订阅工作区可见性变化 */
export function subscribeWorkspace(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useWorkspaceVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 聊天列宽度（px），可拖动调整（范围 300–760，手动拖动钳制在此区间）。 */
const MIN_CHAT = 300, MAX_CHAT = 760
/** 终端模块（tm-main）目标宽度 + 连接面板宽度——自动模式下聊天加宽填满左侧，让终端模块固定此宽，无留白 */
const TARGET_TERM_WIDTH = 480, PANEL_WIDTH = 300
let chatWidth = 460
/** null = 未手动拖过，用自动值（终端模块固定 TARGET_TERM_WIDTH，聊天填满左侧）；非 null = 用拖动值 */
let chatWidthManual: number | null = null
const chatListeners = new Set<() => void>()
export function setChatWidth(w: number): void {
  const clamped = Math.max(MIN_CHAT, Math.min(MAX_CHAT, w))
  chatWidthManual = clamped
  if (chatWidth === clamped) return
  chatWidth = clamped
  chatListeners.forEach(l => l())
}
/** 实际生效的聊天宽度：手动拖过用手动值，否则自动算（终端模块固定 TARGET_TERM_WIDTH，聊天填满剩余，无留白）。 */
export function getEffectiveChatWidth(viewport: number, sidebar: number): number {
  if (chatWidthManual !== null) return chatWidthManual
  return Math.max(MIN_CHAT, viewport - sidebar - TARGET_TERM_WIDTH - PANEL_WIDTH)
}
export function useChatWidth(): number {
  return useSyncExternalStore(
    (cb) => { chatListeners.add(cb); return () => { chatListeners.delete(cb) } },
    () => chatWidth,
  )
}

/** 测试用：获取当前聊天宽度 */
export function getChatWidth(): number { return chatWidth }

/** 测试用：订阅聊天宽度变化 */
export function subscribeChatWidth(cb: () => void): () => void {
  chatListeners.add(cb)
  return () => { chatListeners.delete(cb) }
}

/**
 * 工作区激活时强制 frame 网格成 `sidebar effectiveChat 0px`。
 * effectiveChat = 手动拖动值（拖过则固定）/ 自动值（终端模块固定 TARGET_TERM_WIDTH，聊天填满左侧，无留白）。
 * capture/restore 在 setWorkspaceVisible 里（同步），这里只管强制 + 观察。
 */
export function useFrameLayout(active: boolean, chat: number): number {
  const [left, setLeft] = useState(0)
  const chatRef = useRef(chat)
  chatRef.current = chat

  const applyGrid = (frame: HTMLElement): number => {
    const sidebar = (frame.children[0] as HTMLElement | undefined)?.offsetWidth ?? 264
    const eff = typeof window !== 'undefined' ? getEffectiveChatWidth(window.innerWidth, sidebar) : chatRef.current
    const target = `${sidebar}px ${eff}px 0px`
    if (frame.style.gridTemplateColumns !== target) frame.style.gridTemplateColumns = target
    return sidebar + eff
  }

  useEffect(() => {
    if (!active) { setLeft(0); return }
    const frame = findFrame()
    if (frame === null) return

    let raf = 0
    const apply = (): void => {
      raf = 0
      const n = applyGrid(frame)
      setLeft(prev => (prev === n ? prev : n))
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
    const n = applyGrid(frame)
    setLeft(prev => (prev === n ? prev : n))
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

/** 测试用：获取当前未读集合 */
export function getUnreadSet(): Set<string> { return new Set(unreadSet) }

/** 测试用：订阅未读集合变化 */
export function subscribeUnread(cb: () => void): () => void {
  unreadListeners.add(cb)
  return () => { unreadListeners.delete(cb) }
}

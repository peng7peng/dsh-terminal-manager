/**
 * 工作区可见性 store —— 侧边栏按钮与覆盖层共享开/关状态。
 * 模块级简易 observable，useSyncExternalStore 消费。
 * @module dsh-terminal-manager/client/store
 */

import { useEffect, useSyncExternalStore } from 'react'

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

/** 工作区打开时注入的布局覆盖：把 .app 网格第三列强制成终端宽，聊天（第二列 1fr）自动收窄。 */
const LAYOUT_OVERRIDE_ID = 'tm-layout-override'
const LAYOUT_OVERRIDE_CSS = `.app { grid-template-columns: var(--sbw,264px) minmax(0,1fr) var(--tm-width,45%) !important; }`

/** 注入/移除布局覆盖。打开时调 true，关闭时调 false。 */
export function setLayoutOverride(on: boolean): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(LAYOUT_OVERRIDE_ID)
  if (on) {
    if (existing === null) {
      const tag = document.createElement('style')
      tag.id = LAYOUT_OVERRIDE_ID
      tag.textContent = LAYOUT_OVERRIDE_CSS
      document.head.appendChild(tag)
    }
  } else if (existing !== null) {
    existing.remove()
  }
}

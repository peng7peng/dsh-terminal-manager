/**
 * 工作区可见性 store —— 侧边栏按钮与覆盖层共享开/关状态。
 * 模块级简易 observable，useSyncExternalStore 消费。
 * @module dsh-terminal-manager/client/store
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

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

/**
 * 测 DSH 侧边栏宽度（.app 的 --sbw 变量），覆盖层据此左偏移、不盖侧边栏。
 * 侧边栏收起（.app.collapsed）时 --sbw 变 56px，自动跟随。
 */
export function useSidebarWidth(): number {
  const [width, setWidth] = useState(() => readSbw())
  useEffect(() => {
    const measure = (): void => setWidth(readSbw())
    measure()
    const app = document.querySelector('.app')
    const mo = new MutationObserver(measure)
    if (app !== null) mo.observe(app, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', measure)
    return () => { mo.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return width
}

function readSbw(): number {
  if (typeof document === 'undefined') return 264
  const app = document.querySelector('.app')
  if (app === null) return 264
  const raw = getComputedStyle(app).getPropertyValue('--sbw').trim()
  if (raw === '') return 264
  const num = parseFloat(raw)
  return Number.isFinite(num) ? num : 264
}

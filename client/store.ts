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

/** DSH 布局面板 API（apply 时注入）。 */
export interface LayoutPanel {
  openDetails(): void
  closeDetails(): void
}
let layoutPanel: LayoutPanel | undefined
export function setLayoutPanel(panel: LayoutPanel | undefined): void { layoutPanel = panel }

/** 测 DSH 详情栏宽度（.app grid 第三列）。详情栏关闭时为 0。 */
function readDetailsWidth(): number {
  if (typeof document === 'undefined') return 0
  const app = document.querySelector('.app')
  if (app === null) return 0
  const cols = getComputedStyle(app).gridTemplateColumns.split(/\s+/)
  const details = parseFloat(cols[2] ?? '0')
  return Number.isFinite(details) ? details : 0
}

/** 跟踪详情栏宽度（开/关、拖动、收起侧边栏都重测）。 */
export function useDetailsWidth(): number {
  const [w, setW] = useState(() => readDetailsWidth())
  useEffect(() => {
    const measure = (): void => setW(readDetailsWidth())
    measure()
    const app = document.querySelector('.app')
    const mo = new MutationObserver(measure)
    if (app !== null) mo.observe(app, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', measure)
    // 详情栏宽度变化是异步的（state → 重渲染），多量几次
    const t = setInterval(measure, 200)
    return () => { mo.disconnect(); window.removeEventListener('resize', measure); clearInterval(t) }
  }, [])
  return w
}

/** 打开终端工作区时调用：撑开详情栏让聊天收窄。 */
export function ensureDetailsOpen(): void {
  try { layoutPanel?.openDetails() } catch { /* 布局未就绪 */ }
}

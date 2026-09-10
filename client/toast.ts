/**
 * 轻量 toast —— 模块级队列 + useSyncExternalStore，ToastHost 挂在工作区里渲染。
 * 文件面板 / 编辑器 / TC 执行的结果反馈都走这里（交互设计 §8.1 反馈层级）。
 * @module dsh-terminal-manager/client/toast
 */

import { useSyncExternalStore } from 'react'

export interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
}

let seq = 0
let items: ToastItem[] = []
const listeners = new Set<() => void>()
function emit(): void { for (const l of listeners) l() }

/** 弹一条 toast；默认 2.8s 后消失（error 5s）。 */
export function toast(text: string, kind: ToastItem['kind'] = 'info', ttlMs?: number): void {
  const id = ++seq
  items = [...items, { id, text, kind }]
  emit()
  const ttl = ttlMs ?? (kind === 'error' ? 5000 : 2800)
  setTimeout(() => {
    items = items.filter(i => i.id !== id)
    emit()
  }, ttl)
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => items,
  )
}

/** 测试用：清空。 */
export function clearToasts(): void { items = []; emit() }

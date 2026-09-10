/**
 * F10 执行状态（汇总条数据源）—— 模块级 store：常驻直到用户关闭（§11.3）。
 * @module dsh-terminal-manager/client/tc/tcRunStore
 */

import { useSyncExternalStore } from 'react'
import type { RunItem } from './runScript.ts'

export interface TcRunState {
  title: string
  items: RunItem[]
  running: boolean
  startedAt: number
  finishedAt?: number
  abort?: () => void
}

let state: TcRunState | null = null
const listeners = new Set<() => void>()
function emit(): void { for (const l of listeners) l() }

export function setTcRun(next: TcRunState | null): void { state = next; emit() }
export function patchTcRun(patch: Partial<TcRunState>): void { if (state !== null) { state = { ...state, ...patch }; emit() } }
export function getTcRun(): TcRunState | null { return state }
export function useTcRun(): TcRunState | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}

const SKIP_KEY = 'tm.tc.skipConfirm'
/** 「本次会话不再确认」：sessionStorage（刷新 / 重开工作区后恢复弹框） */
export function getSkipConfirm(): boolean {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SKIP_KEY) === '1' } catch { return false }
}
export function setSkipConfirm(v: boolean): void {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SKIP_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

const SEND_SKIP_KEY = 'tm.tc.sendSkipConfirm'
/** 「发送选中不再提示」：勾选后直接按广播栏所选终端发送；右键「发送选中到终端…」仍会弹框（逃生门）。 */
export function getSendSkipConfirm(): boolean {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SEND_SKIP_KEY) === '1' } catch { return false }
}
export function setSendSkipConfirm(v: boolean): void {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SEND_SKIP_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

/**
 * F10 TC 脚本执行器 —— 纯逻辑（注入 send 函数，便于测试）。
 *
 * planRun：解析结果 × TC 映射快照 → 执行项（每条命令 × 每个目标一项；无对应在线终端标 no-target）。
 * runPlan：不同行串行（上一行全部完成或超时才发下一行）；同一行的多个目标并行（不同设备互不阻塞）。
 * 超时项：onTimeout 决定「继续 / 中止」；中止后剩余项标 aborted。
 * @module dsh-terminal-manager/client/tc/runScript
 */

import type { TcLine } from '../../src/tc-parser.ts'
import type { TcTarget } from './tcMap.ts'

export type RunStatus = 'pending' | 'running' | 'ok' | 'timeout' | 'error' | 'no-target' | 'aborted'

export interface RunItem {
  key: string
  lineNo: number
  command: string
  tc: number
  sessionId?: string
  label?: string
  status: RunStatus
  waitReason?: string
  message?: string
}

export interface SendResultLike {
  waitReason: string
  output?: string
}

export interface RunOptions {
  send: (sessionId: string, command: string) => Promise<SendResultLike>
  onUpdate?: (items: RunItem[]) => void
  /** 某项超时后问一句；缺省继续 */
  onTimeout?: (item: RunItem) => Promise<'continue' | 'abort'>
  signal?: AbortSignal
}

/** 把命令行展开成执行项。映射快照在执行期间冻结（不随会话变化重算）。 */
export function planRun(lines: readonly TcLine[], targets: ReadonlyMap<number, TcTarget>): RunItem[] {
  const items: RunItem[] = []
  for (const line of lines) {
    if (line.kind !== 'command' || line.command === undefined) continue
    for (const tc of line.targets) {
      const t = targets.get(tc)
      items.push({
        key: `${line.lineNo}:${tc}`,
        lineNo: line.lineNo,
        command: line.command,
        tc,
        ...(t !== undefined ? { sessionId: t.sessionId, label: t.label } : {}),
        status: t !== undefined ? 'pending' : 'no-target',
      })
    }
  }
  return items
}

/** 用到的 TC 编号（去重、升序）及每个编号的命令数。 */
export function tcUsage(items: readonly RunItem[]): Array<{ tc: number; count: number; target?: TcTarget }> {
  const m = new Map<number, { count: number; target?: TcTarget }>()
  for (const it of items) {
    const cur = m.get(it.tc) ?? { count: 0 }
    cur.count += 1
    if (it.sessionId !== undefined && it.label !== undefined) cur.target = { sessionId: it.sessionId, label: it.label }
    m.set(it.tc, cur)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([tc, v]) => ({ tc, count: v.count, ...(v.target !== undefined ? { target: v.target } : {}) }))
}

function stripCode(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.replace(/^[A-Z_]+:\s*/, '')
}

/** 按行分组（保持出现顺序）。 */
function groupByLine(items: readonly RunItem[]): RunItem[][] {
  const groups: RunItem[][] = []
  let cur: RunItem[] = []
  let lineNo = -1
  for (const it of items) {
    if (it.lineNo !== lineNo) {
      if (cur.length > 0) groups.push(cur)
      cur = []
      lineNo = it.lineNo
    }
    cur.push(it)
  }
  if (cur.length > 0) groups.push(cur)
  return groups
}

/** 执行计划；返回最终状态（同一数组对象的拷贝）。 */
export async function runPlan(plan: readonly RunItem[], opts: RunOptions): Promise<RunItem[]> {
  const items = plan.map(it => ({ ...it }))
  const update = (): void => opts.onUpdate?.(items.map(it => ({ ...it })))
  const abortRest = (from: number): void => {
    for (let i = from; i < items.length; i++) {
      if (items[i]!.status === 'pending') items[i]!.status = 'aborted'
    }
  }
  const groups = groupByLine(items)
  let done = 0
  for (const group of groups) {
    if (opts.signal?.aborted) { abortRest(0); update(); return items }
    const runnable = group.filter(it => it.status === 'pending')
    for (const it of runnable) it.status = 'running'
    update()
    await Promise.all(runnable.map(async (it) => {
      try {
        const r = await opts.send(it.sessionId!, it.command)
        it.waitReason = r.waitReason
        it.status = r.waitReason === 'timeout' ? 'timeout' : 'ok'
      } catch (error) {
        it.status = 'error'
        it.message = stripCode(error)
      }
    }))
    done += group.length
    update()
    const timedOut = runnable.filter(it => it.status === 'timeout')
    if (timedOut.length > 0 && opts.onTimeout !== undefined) {
      for (const it of timedOut) {
        const decision = await opts.onTimeout(it)
        if (decision === 'abort') { abortRest(0); update(); return items }
      }
    }
  }
  void done
  update()
  return items
}

export interface RunSummary { ok: number; timeout: number; error: number; noTarget: number; aborted: number; total: number }

export function summarize(items: readonly RunItem[]): RunSummary {
  const s: RunSummary = { ok: 0, timeout: 0, error: 0, noTarget: 0, aborted: 0, total: items.length }
  for (const it of items) {
    if (it.status === 'ok') s.ok++
    else if (it.status === 'timeout') s.timeout++
    else if (it.status === 'error') s.error++
    else if (it.status === 'no-target') s.noTarget++
    else if (it.status === 'aborted') s.aborted++
  }
  return s
}

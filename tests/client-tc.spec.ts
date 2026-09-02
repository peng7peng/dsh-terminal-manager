/**
 * F10 TC 执行逻辑：映射、计划展开、串行 / 并行、超时决策、中止、汇总。
 */
import { describe, expect, it, vi } from 'vitest'
import { parseTcScript } from '../src/tc-parser.ts'
import { planRun, runPlan, summarize, tcUsage, type RunItem } from '../client/tc/runScript.ts'
import { buildTcOrder, tcIndexMap, tcTargetMap } from '../client/tc/tcMap.ts'

const SESSIONS = [
  { sessionId: 'a', label: 'dut-a', status: 'open' },
  { sessionId: 'b', label: 'dut-b', status: 'closed' },
  { sessionId: 'c', label: 'dut-c', status: 'open' },
]

describe('tcMap', () => {
  it('open 会话按顺序编号，closed 不占号', () => {
    expect(buildTcOrder(SESSIONS)).toEqual(['a', 'c'])
    expect([...tcIndexMap(['a', 'c']).entries()]).toEqual([['a', 0], ['c', 1]])
    const m = tcTargetMap(SESSIONS)
    expect(m.get(0)).toEqual({ sessionId: 'a', label: 'dut-a' })
    expect(m.get(1)).toEqual({ sessionId: 'c', label: 'dut-c' })
    expect(m.has(2)).toBe(false)
  })
})

const SCRIPT = '##>0\nls\n##>01\npwd\n##>5\nwhoami\n[节]\n##注释\n'

describe('planRun / tcUsage', () => {
  it('每条命令 × 每个目标一项；无对应终端标 no-target；标题注释不进计划', () => {
    const items = planRun(parseTcScript(SCRIPT), tcTargetMap(SESSIONS))
    expect(items.map(i => `${i.lineNo}:${i.tc}:${i.status}:${i.sessionId ?? '-'}`)).toEqual([
      '2:0:pending:a', '4:0:pending:a', '4:1:pending:c', '6:5:no-target:-',
    ])
    expect(tcUsage(items)).toEqual([
      { tc: 0, count: 2, target: { sessionId: 'a', label: 'dut-a' } },
      { tc: 1, count: 1, target: { sessionId: 'c', label: 'dut-c' } },
      { tc: 5, count: 1 },
    ])
  })
})

function fakeSend(behavior: Record<string, 'ok' | 'timeout' | 'throw'> = {}, delayMs = 1) {
  const calls: Array<{ sid: string; cmd: string; at: number }> = []
  let t = 0
  const send = vi.fn(async (sid: string, cmd: string) => {
    calls.push({ sid, cmd, at: t++ })
    await new Promise(r => setTimeout(r, delayMs))
    const b = behavior[cmd] ?? 'ok'
    if (b === 'throw') throw new Error('DISCONNECTED: 会话已断开')
    return { waitReason: b === 'timeout' ? 'timeout' : 'quiet', output: '' }
  })
  return { send, calls }
}

describe('runPlan', () => {
  it('不同行串行、同一行多目标并行；no-target 跳过；最终汇总', async () => {
    const items = planRun(parseTcScript(SCRIPT), tcTargetMap(SESSIONS))
    const { send, calls } = fakeSend()
    const updates: RunItem[][] = []
    const result = await runPlan(items, { send, onUpdate: (x) => updates.push(x) })
    expect(calls.map(c => `${c.sid}:${c.cmd}`)).toEqual(['a:ls', 'a:pwd', 'c:pwd'])
    // pwd 两个目标在同一批发出（ls 完成之后）
    expect(calls[1]!.at).toBe(1)
    expect(calls[2]!.at).toBe(2)
    expect(result.map(i => i.status)).toEqual(['ok', 'ok', 'ok', 'no-target'])
    expect(summarize(result)).toEqual({ ok: 3, timeout: 0, error: 0, noTarget: 1, aborted: 0, total: 4 })
    expect(updates.length).toBeGreaterThan(0)
    // 传入的 plan 不被改动
    expect(items[0]!.status).toBe('pending')
  })

  it('超时：onTimeout 返回 continue 则继续；返回 abort 则剩余标 aborted', async () => {
    const lines = parseTcScript('##>0\nslow\nnext\nlast\n')
    const targets = tcTargetMap(SESSIONS)
    {
      const { send, calls } = fakeSend({ slow: 'timeout' })
      const r = await runPlan(planRun(lines, targets), { send, onTimeout: async () => 'continue' })
      expect(r.map(i => i.status)).toEqual(['timeout', 'ok', 'ok'])
      expect(calls).toHaveLength(3)
    }
    {
      const { send, calls } = fakeSend({ slow: 'timeout' })
      const r = await runPlan(planRun(lines, targets), { send, onTimeout: async () => 'abort' })
      expect(r.map(i => i.status)).toEqual(['timeout', 'aborted', 'aborted'])
      expect(calls).toHaveLength(1)
    }
  })

  it('发送抛错：该项 error（消息去掉错误码），后续继续', async () => {
    const lines = parseTcScript('##>0\nbad\ngood\n')
    const { send } = fakeSend({ bad: 'throw' })
    const r = await runPlan(planRun(lines, tcTargetMap(SESSIONS)), { send })
    expect(r[0]).toMatchObject({ status: 'error', message: '会话已断开' })
    expect(r[1]?.status).toBe('ok')
  })

  it('signal 中止：下一行不再发送，剩余标 aborted', async () => {
    const lines = parseTcScript('##>0\none\ntwo\nthree\n')
    const ac = new AbortController()
    const { send, calls } = fakeSend({}, 5)
    const p = runPlan(planRun(lines, tcTargetMap(SESSIONS)), { send, signal: ac.signal })
    await new Promise(r => setTimeout(r, 2))
    ac.abort()
    const r = await p
    expect(calls).toHaveLength(1)
    expect(r.map(i => i.status)).toEqual(['ok', 'aborted', 'aborted'])
  })
})

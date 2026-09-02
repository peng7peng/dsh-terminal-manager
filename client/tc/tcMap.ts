/**
 * TC 编号映射（D1）：TC 编号 = 活跃会话列表里 open 会话的顺序（0 起）。
 * 断线（closed）不占编号；隐藏窗格占编号；纯函数，前端实时算，不落盘。
 * @module dsh-terminal-manager/client/tc/tcMap
 */

export interface TcSession {
  sessionId: string
  label: string
  status: string
}

/** open 会话按给定顺序 → sessionId 列表（下标 = TC 编号） */
export function buildTcOrder(sessions: readonly TcSession[]): string[] {
  return sessions.filter(s => s.status === 'open').map(s => s.sessionId)
}

/** sessionId → TC 编号 */
export function tcIndexMap(order: readonly string[]): Map<string, number> {
  return new Map(order.map((sid, i) => [sid, i]))
}

export interface TcTarget { sessionId: string; label: string }

/** TC 编号 → 会话（含名字）；编号无对应在线会话时不在 map 里 */
export function tcTargetMap(sessions: readonly TcSession[]): Map<number, TcTarget> {
  const m = new Map<number, TcTarget>()
  buildTcOrder(sessions).forEach((sid, i) => {
    const s = sessions.find(x => x.sessionId === sid)
    if (s !== undefined) m.set(i, { sessionId: sid, label: s.label })
  })
  return m
}

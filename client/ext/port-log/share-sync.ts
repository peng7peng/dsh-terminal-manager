import { portLogRpc, subscribePortLogEvents } from './rpc.ts'
import { applyPortLogEvent, setShares, type ClientShare } from './store.ts'

/** 实时更新加权威快照：补回窗口关闭或 SSE 断线期间漏掉的连接变化。 */
export function subscribeShares(reportError: (message: string | null) => void): () => void {
  const controller = new AbortController()
  let revision = 0
  let loading = false
  const refresh = async (): Promise<void> => {
    if (loading || controller.signal.aborted) return
    loading = true
    const requestedRevision = revision
    try {
      const shares = await portLogRpc<ClientShare[]>('shares.list', {}, controller.signal)
      if (controller.signal.aborted) return
      // 请求期间到达的新事件比快照更新，不能被旧响应覆盖。
      if (requestedRevision === revision) setShares(shares)
      reportError(null)
    } catch {
      if (!controller.signal.aborted) reportError('共享状态同步失败，正在重试')
    } finally {
      loading = false
    }
  }
  const unsubscribe = subscribePortLogEvents((type, data) => {
    if (controller.signal.aborted) return
    if (type === 'share-status' || type === 'share-removed') revision++
    applyPortLogEvent(type, data)
  }, () => { void refresh() })
  void refresh()
  const timer = setInterval(() => { void refresh() }, 3000)
  return () => {
    controller.abort()
    clearInterval(timer)
    unsubscribe()
  }
}

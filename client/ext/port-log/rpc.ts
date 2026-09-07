const PREFIX = '/term-manager/ext/port-log'

export interface PortLogRpcError extends Error { code: string }

function rpcError(code: string, message: string): PortLogRpcError {
  const error = new Error(`${code}: ${message}`) as PortLogRpcError
  error.code = code
  return error
}

export async function portLogRpc<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(PREFIX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw rpcError(`HTTP_${response.status}`, `请求失败：${response.status}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw rpcError(body.result.error.code, body.result.error.message)
  return body.result.value
}

export function subscribePortLogEvents(
  onEvent: (type: string, data: unknown) => void,
  onOpen: () => void,
): () => void {
  const source = new EventSource(`${PREFIX}/events`)
  const types = ['mapping-status', 'mapping-removed', 'share-status', 'share-removed', 'session-log-status', 'app-log-status']
  const handlers = types.map((type) => {
    const handler = (event: MessageEvent<string>): void => {
      try { onEvent(type, JSON.parse(event.data)) } catch { /* 下一次全量刷新会恢复 */ }
    }
    source.addEventListener(type, handler as EventListener)
    return [type, handler] as const
  })
  source.addEventListener('open', onOpen)
  return () => {
    source.removeEventListener('open', onOpen)
    for (const [type, handler] of handlers) source.removeEventListener(type, handler as EventListener)
    source.close()
  }
}

/**
 * 浏览器侧指令通道客户端 —— 往 /api/term-manager.<method> POST（DSH 标准 ClientRequest 封包）。
 * host 端 connection.rpc.intercept 拦截并解封，调度到 remotes.dispatch。
 * @module dsh-terminal-manager/client/rpc
 */

export interface RpcError extends Error {
  code: string
}

function makeError(code: string, message: string): RpcError {
  const error = new Error(`${code}: ${message}`) as RpcError
  error.code = code
  return error
}

/** 调用后端指令通道。失败抛 RpcError（code 在 error.code）。
 *  独立 channel /term-manager（不抢 /api）；POST 到 /term-manager/<方法>。 */
export async function rpc<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/term-manager/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!response.ok) throw makeError('HTTP_' + response.status, `请求失败: ${response.statusText}`)
  const body = (await response.json()) as { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }
  if (!body.result.ok) throw makeError(body.result.error.code, body.result.error.message)
  return body.result.value
}

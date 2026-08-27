/**
 * B7a 指令通道 —— 前端控制面 RPC。
 *
 * 前端经通道①（HTTP）调用这些方法：连接配置增删改查、会话连接/断开/列表/读缓冲。
 * 调度逻辑是纯函数（dispatch），便于直接测试；registerRemotes 负责挂到 ctx.connection.rpc。
 * 挂载方式定案：ctx.connection.rpc.handle('/term-manager', handler, { authority: 'trusted-host' })
 * （参考 packages/client/connection/src/rpc-host.ts；typert remotes 留作后续升级）。
 * @module dsh-terminal-manager/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionConfig, ConnectionInput } from './connection-store.ts'
import { StoreNotFoundError, StoreValidationError } from './connection-store.ts'
import type { SessionManager, SessionSnapshot } from './session-manager.ts'
import { SessionError } from './session-manager.ts'

/** 指令通道的依赖（注入便于测试）。 */
export interface RemoteDeps {
  sessions: SessionManager
  store: import('./connection-store.ts').ConnectionStore
}

/** 连接页查询/表单的载荷类型。 */
type Payload = Record<string, unknown>

/** 把领域异常折叠成 RpcResult 的错误分支（code 编进 message，M4 可细化）。 */
function toError(error: unknown): RpcResult<never>['error'] {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'INTERNAL'
  return { code: 'internal', message: `${code}: ${message}`, details: {} }
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/**
 * 纯调度：按 endpoint 名分发，返回 RpcResult。不依赖 ctx，便于直接测试。
 */
export async function dispatch(
  endpoint: string,
  payload: Payload,
  deps: RemoteDeps,
  signal: AbortSignal,
): Promise<RpcResult<unknown>> {
  try {
    await deps.store.ensureLoaded()
    switch (endpoint) {
      case 'connections.list':
        return ok(deps.store.list())
      case 'connections.create': {
        const created = await deps.store.create(payload as unknown as ConnectionInput)
        return ok(created)
      }
      case 'connections.update': {
        const { id, patch } = payload as { id: string; patch: Partial<ConnectionInput> }
        const updated = await deps.store.update(id, patch)
        return ok(updated)
      }
      case 'connections.remove': {
        const { id } = payload as { id: string }
        await deps.store.remove(id)
        return ok({ id })
      }
      case 'sessions.list':
        return ok(deps.sessions.list())
      case 'sessions.connect': {
        const { connId, protocol, host, port, username, password, label, telnetMode, connectTimeoutMs } = payload as {
          connId?: string; protocol?: 'ssh' | 'telnet'; host?: string; port?: number; username?: string; password?: string; label?: string; telnetMode?: 'telnet' | 'raw'; connectTimeoutMs?: number
        }
        const snap = connId !== undefined && connId.length > 0
          ? await deps.sessions.connectByConnId(connId)
          : await deps.sessions.connect({
              protocol: protocol ?? 'telnet', host: host ?? '127.0.0.1', port: port ?? 23,
              ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}),
              ...(label !== undefined ? { label } : {}),
              ...(telnetMode !== undefined ? { telnetMode } : {}),
              ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
            })
        return ok(snap)
      }
      case 'sessions.disconnect': {
        const { sessionId } = payload as { sessionId: string }
        await deps.sessions.disconnect(sessionId)
        return ok({ sessionId })
      }
      case 'sessions.read': {
        const { sessionId, count } = payload as { sessionId: string; count?: number }
        return ok(deps.sessions.read(sessionId, count))
      }
      default:
        return { ok: false, error: { code: 'internal', message: `未知方法: ${endpoint}`, details: {} } }
    }
  } catch (error) {
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: '已取消', details: {} } }
    }
    return { ok: false, error: toError(error) }
  }
}

/** 已知的错误码集合（前端可据此展示，见方案 3.6）。 */
export const REMOTE_ERROR_CODES = [
  'VALIDATION', 'AUTH_FAILED', 'HOST_UNREACHABLE', 'CONN_TIMEOUT',
  'SESSION_NOT_FOUND', 'SESSION_BUSY', 'DISCONNECTED', 'COMMAND_BLOCKED', 'PROTO_ERROR',
] as const

/**
 * 把指令通道挂成 webServer 的前缀路由 /term-manager（绕开 connection.rpc.handle——
 * 后者经 connection 服务的 ctx.effect 注册，作用域问题导致路由没进 webServer 表）。
 * 客户端 POST 到 /term-manager/<方法>，body = ClientRequest 封包，返回 ClientResponse。
 * 信任栅栏：MVP 仅 loopback（webServer 本机绑定时已限）。
 */
export function registerRemotes(ctx: Context, deps: RemoteDeps): () => void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.log('[term-manager] webServer 不可用，remotes 未挂载')
    return () => {}
  }
  console.log('[term-manager] 挂载 /term-manager 前缀路由（直连 webServer）')
  const route = {
    kind: 'prefix' as const,
    path: '/term-manager',
    handler: async (req, res) => {
      // CORS 预检：浏览器 POST application/json 前会先 OPTIONS，必须放行
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      let rpcId = '', method = '', payload: unknown = {}
      try {
        const body = JSON.parse(raw) as { type?: string; rpcId?: string; method?: string; payload?: unknown }
        rpcId = body.rpcId ?? ''
        method = body.method ?? ''
        payload = body.payload ?? {}
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid', result: { ok: false, error: { code: 'bad-request', message: 'invalid JSON', details: {} } } }))
        return
      }
      const urlMethod = (req.url ?? '').replace(/^\/term-manager\//, '').split('?')[0]
      const endpoint = method || urlMethod
      try {
        const result = await dispatch(endpoint, payload as Payload, deps, new AbortController().signal)
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: toError(error) } }))
      }
    },
  }
  // ctx.effect(fn)：fn 立即执行、其返回值是清理函数。把 register 放进 fn，
  // 返回的 disposer 才会被存为清理（而不是被立即执行删掉路由）。
  ctx.effect(() => webServer.register(route), 'terminal-manager: /term-manager 路由')
  return () => {}
}

/** 仅用于类型导出（前端类型生成可用）。 */
export type { ConnectionConfig, SessionSnapshot, StoreValidationError, SessionError }

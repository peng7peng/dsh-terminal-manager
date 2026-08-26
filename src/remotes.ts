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
        const { connId } = payload as { connId: string }
        const snap = await deps.sessions.connectByConnId(connId)
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
 * 把指令通道挂到 ctx.connection.rpc（若可用）。返回卸载函数。
 * 通道路径 /term-manager；信任策略 trusted-host（受信主机/loopback 均可）。
 */
export function registerRemotes(ctx: Context, deps: RemoteDeps): () => void {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    // 测试环境或无 client-connection 的部署：不挂载，调度函数仍可直测
    return () => {}
  }
  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal) =>
    dispatch(endpoint, (payload ?? {}) as Payload, deps, signal)
  let disposer: Promise<() => Promise<void>> | undefined
  // 注册异步返回卸载器；effect 同步返回清理函数，内部 await 卸载
  void connection.rpc.handle('/term-manager', handler, { authority: 'trusted-host' }).then(d => { disposer = d })
  return () => {
    void disposer?.then(d => d())
  }
}

/** 仅用于类型导出（前端类型生成可用）。 */
export type { ConnectionConfig, SessionSnapshot, StoreValidationError, SessionError }

/**
 * B7a 指令通道 —— 前端控制面 RPC。
 *
 * 前端经通道①（HTTP）调用这些方法：连接配置增删改查、会话连接/断开/重连/列表/读缓冲。
 * 调度逻辑是纯函数（dispatch），便于直接测试；registerRemotes 负责挂到 ctx.webServer。
 * 挂载方式：ctx.webServer.register({ kind: 'prefix', prefix: '/term-manager' })
 * @module dsh-terminal-manager/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Config } from './config.ts'
import type { ConnectionConfig, ConnectionInput } from './connection-store.ts'
import { StoreNotFoundError, StoreValidationError } from './connection-store.ts'
import type { SessionManager, SessionSnapshot } from './session-manager.ts'
import type { FileService, LocalPathRef } from './types/file-service.ts'
import type { SendOptions } from './types/session-api.ts'
import { FileServiceError } from './file-errors.ts'
import { SessionError } from './session-manager.ts'

/** 指令通道的依赖（注入便于测试）。 */
export interface RemoteDeps {
  sessions: SessionManager
  store: import('./connection-store.ts').ConnectionStore
  /** 插件配置（workspaceRoot 等）；测试可省略 */
  config?: Config
  /** 文件服务（B10）；未注入时 files.* 端点返回 UNSUPPORTED */
  files?: FileService
}

function requireFiles(deps: RemoteDeps): FileService {
  if (deps.files === undefined) throw new FileServiceError('UNSUPPORTED', '文件服务未启用')
  return deps.files
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
        const { connId, protocol, host, port, username, password, label, telnetMode, connectTimeoutMs, newline, localEcho } = payload as {
          connId?: string; protocol?: 'ssh' | 'telnet'; host?: string; port?: number; username?: string; password?: string; label?: string; telnetMode?: 'telnet' | 'raw'; connectTimeoutMs?: number; newline?: 'lf' | 'cr' | 'crlf'; localEcho?: boolean
        }
        const snap = connId !== undefined && connId.length > 0
          ? await deps.sessions.connectByConnId(connId)
          : await deps.sessions.connect({
              protocol: protocol ?? 'telnet', host: host ?? '127.0.0.1', port: port ?? 23,
              ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}),
              ...(label !== undefined ? { label } : {}),
              ...(telnetMode !== undefined ? { telnetMode } : {}),
              ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
              ...(newline !== undefined ? { newline } : {}),
              ...(localEcho !== undefined ? { localEcho } : {}),
            })
        return ok(snap)
      }
      case 'sessions.disconnect': {
        const { sessionId } = payload as { sessionId: string }
        await deps.sessions.disconnect(sessionId)
        return ok({ sessionId })
      }
      case 'sessions.reconnect': {
        const { sessionId } = payload as { sessionId: string }
        const snap = await deps.sessions.reconnect(sessionId)
        return ok(snap)
      }
      case 'sessions.read': {
        const { sessionId, count } = payload as { sessionId: string; count?: number }
        return ok(deps.sessions.read(sessionId, count))
      }
      // 编辑器路径：一条命令一次 sendAndWait（TC 执行 / 发送选中逐条调用；不过守卫，来源缺省 script）
      case 'sessions.send': {
        const { sessionId, command, source, wait, newline, submit } = payload as {
          sessionId: string; command: string; source?: SendOptions['source']; wait?: SendOptions['wait']; newline?: SendOptions['newline']; submit?: boolean
        }
        const result = await deps.sessions.sendAndWait(sessionId, command, {
          source: source ?? 'script',
          ...(wait !== undefined ? { wait } : {}),
          ...(newline !== undefined ? { newline } : {}),
          ...(submit !== undefined ? { submit } : {}),
          signal,
        })
        return ok(result)
      }
      // 本地文件（B10）：root 由前端每次传入（当前树根），path 必须在 root 内
      case 'files.tree': {
        const ref = payload as unknown as LocalPathRef
        return ok(await requireFiles(deps).listLocal(ref))
      }
      case 'files.read': {
        const { root, path, maxBytes } = payload as unknown as LocalPathRef & { maxBytes?: number }
        return ok(await requireFiles(deps).readLocal({ root, path }, maxBytes !== undefined ? { maxBytes } : {}))
      }
      case 'files.write': {
        const { root, path, content } = payload as unknown as LocalPathRef & { content: string }
        if (typeof content !== 'string') throw new FileServiceError('VALIDATION', 'content 必须是字符串')
        return ok(await requireFiles(deps).writeLocal({ root, path }, content))
      }
      case 'files.dirs': {
        const { path } = payload as { path: string }
        return ok(await requireFiles(deps).listDirectories(path))
      }
      case 'files.root':
        return ok({ root: deps.config?.workspaceRoot ?? process.cwd() })
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
  'PATH_OUTSIDE_ROOT', 'NOT_FOUND', 'FILE_TOO_LARGE', 'REMOTE_IO', 'UNSUPPORTED',
] as const

/** 来源围栏：只放行本机页面。无 Origin（同源 GET / 非浏览器）放行；Origin 是 loopback 或与 Host 相同放行；其余 403。
 *  背景：本插件的页面与路由同源（fetch 相对路径），本不需要 CORS；但 files.* 端点能读写本机文件，
 *  不能让互联网上的恶意网页借浏览器跨源打进来（CSRF）。 */
export function isTrustedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  let url: URL
  try { url = new URL(origin) } catch { return false }
  const h = url.hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return true
  return host !== undefined && url.host.toLowerCase() === host.toLowerCase()
}

/**
 * 构造 HTTP 路由 handler（便于独立测试）。
 * 返回一个 (req, res) => void 的异步函数。
 */
export function createHttpHandler(deps: RemoteDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    const origin = req.headers.origin
    if (!isTrustedOrigin(origin, req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden origin' }))
      return
    }
    // 允许的来源原样回显（不再用 *）；同源请求没有 Origin 时不发 CORS 头
    const cors: Record<string, string> = origin !== undefined && origin !== '' ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {}
    // CORS 预检：浏览器 POST application/json 前会先 OPTIONS，必须放行
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
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
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: toError(error) } }))
    }
  }
}

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
    handler: (req: IncomingMessage, res: ServerResponse) => createHttpHandler(deps)(req, res),
  }
  // ctx.effect(fn)：fn 立即执行、其返回值是清理函数。把 register 放进 fn，
  // 返回的 disposer 才会被存为清理（而不是被立即执行删掉路由）。
  ctx.effect(() => webServer.register(route), 'terminal-manager: /term-manager 路由')
  return () => {}
}

/** 仅用于类型导出（前端类型生成可用）。 */
export type { ConnectionConfig, SessionSnapshot, StoreValidationError, SessionError }

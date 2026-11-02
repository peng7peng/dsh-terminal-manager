/**
 * B7a 指令通道 —— 前端控制面 RPC。
 *
 * 前端经通道①（HTTP）调用这些方法：连接配置增删改查、会话连接/断开/重连/列表/读缓冲。
 * 调度逻辑是纯函数（dispatch），便于直接测试；registerRemotes 把 RPC 挂到 Connection 的
 * 专用 channel `/term-manager`（DSH 统一认证），文件流挂到 Connection 的精确 Fetch 路由。
 * @module dsh-terminal-manager/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandlerResult, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from 'node:crypto'
import { basename as posixBasename } from 'node:path/posix'
import { Readable } from 'node:stream'
import type { Config } from './config.ts'
import type { ConnectionConfig, ConnectionInput } from './connection-store.ts'
import { StoreNotFoundError, StoreValidationError } from './connection-store.ts'
import type { SessionManager, SessionSnapshot } from './session-manager.ts'
import type { FileProgressFrame } from './ws-io.ts'
import type { FileService, LocalPathRef } from './types/file-service.ts'
import type { LocalPanelState } from './local-panel-state.ts'
import type { SendOptions } from './types/session-api.ts'
import { stat } from 'node:fs/promises'
import { FileServiceError, mapFsError } from './file-errors.ts'
import { resolveInsideRoot } from './path-security.ts'
import { SessionError } from './session-manager.ts'

/** 指令通道的依赖（注入便于测试）。 */
export interface RemoteDeps {
  sessions: SessionManager
  store: import('./connection-store.ts').ConnectionStore
  /** 插件配置（workspaceRoot 等）；测试可省略 */
  config?: Config
  /** 文件服务（B10）；未注入时 files.* 端点返回 UNSUPPORTED */
  files?: FileService
  /** 用系统默认程序打开本机文件（files.open）；未注入时返回 UNSUPPORTED */
  openExternal?: (path: string) => Promise<void>
  /** 文件传输进度帧广播（B7b /term-io；未注入时传输仍可用，只是没有进度帧） */
  broadcastFileProgress?: (frame: FileProgressFrame) => void
  /** 本地面板状态镜像（root/cwd）；前端推送、工具层读 */
  localPanel?: LocalPanelState
}

function requireFiles(deps: RemoteDeps): FileService {
  if (deps.files === undefined) throw new FileServiceError('UNSUPPORTED', '文件服务未启用')
  return deps.files
}

/** 连接页查询/表单的载荷类型。 */
type Payload = Record<string, unknown>

/** Connection 的统一 RPC 结果（与 DSH 0.2.1 的 /api 通道一致）。 */
type RpcResult<T> = ConnectionRpcResult<T>

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
  if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: '已取消', details: {} } }
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
        const { connId, protocol, host, port, username, password, privateKey, passphrase, label, telnetMode, connectTimeoutMs, newline, localEcho } = payload as {
          connId?: string; protocol?: 'ssh' | 'telnet'; host?: string; port?: number; username?: string; password?: string; privateKey?: string; passphrase?: string; label?: string; telnetMode?: 'telnet' | 'raw'; connectTimeoutMs?: number; newline?: 'lf' | 'cr' | 'crlf'; localEcho?: boolean
        }
        const auth = password !== undefined
          ? { kind: 'password' as const, password }
          : privateKey !== undefined
            ? { kind: 'key' as const, privateKey, ...(passphrase !== undefined ? { passphrase } : {}) }
            : undefined
        const snap = connId !== undefined && connId.length > 0
          ? await deps.sessions.connectByConnId(connId)
          : await deps.sessions.connect({
              protocol: protocol ?? 'telnet', host: host ?? '127.0.0.1', port: port ?? 23,
              ...(username !== undefined ? { username } : {}),
              ...(auth !== undefined ? { auth } : {}),
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
        return ok({
          root: deps.config?.workspaceRoot ?? process.cwd(),
          ...(deps.localPanel !== undefined && deps.localPanel.cwd.length > 0
            ? { localCwd: deps.localPanel.cwd, localRoot: deps.localPanel.root }
            : {}),
        })
      // 前端面板每次目录切换后推送 { root, cwd }，工具层据此做下载默认目录 + 围栏基准
      case 'files.setLocalPanel': {
        const { root, cwd } = payload as { root: string; cwd: string }
        if (deps.localPanel !== undefined) {
          deps.localPanel.root = root
          deps.localPanel.cwd = cwd
        }
        return ok({})
      }
      // 非文本文件（xlsx / docx / pdf …）交给用户本机的默认程序打开；只允许树根内的文件
      case 'files.open': {
        const { root, path } = payload as unknown as LocalPathRef
        if (deps.openExternal === undefined) throw new FileServiceError('UNSUPPORTED', '系统程序打开未启用')
        const real = await resolveInsideRoot(root, path)
        const st = await stat(real).catch((e: unknown) => { throw mapFsError(e, '文件') })
        if (!st.isFile()) throw new FileServiceError('VALIDATION', '只能打开文件，不能打开目录')
        await deps.openExternal(real)
        return ok({ path: real })
      }
      // ── 远端（S5）：SSH 会话 → SFTP；Telnet → UNSUPPORTED（FileService 按协议分派）──
      case 'files.remoteTree': {
        const { sessionId, path } = payload as { sessionId: string; path: string }
        return ok(await requireFiles(deps).listRemote({ sessionId, path }))
      }
      case 'files.remoteCwd': {
        const { sessionId } = payload as { sessionId: string }
        return ok(await requireFiles(deps).remoteCwd({ sessionId }))
      }
      case 'files.downloadToLocal': {
        const { sessionId, remotePath, root, path, transferId } = payload as {
          sessionId: string; remotePath: string; root: string; path: string; transferId?: string
        }
        const id = transferIdOf(transferId)
        try {
          const result = await requireFiles(deps).downloadToLocal({
            sessionId,
            remotePath,
            target: { root, path },
            onProgress: (p) => deps.broadcastFileProgress?.({ kind: 'file-progress', transferId: id, ...p }),
          })
          deps.broadcastFileProgress?.({ kind: 'file-progress', transferId: id, op: 'download', sessionId, remotePath, transferred: result.bytes, done: true, ok: true })
          return ok({ ...result, transferId: id })
        } catch (error) {
          deps.broadcastFileProgress?.({
            kind: 'file-progress', transferId: id, op: 'download', sessionId, remotePath,
            transferred: 0, done: true, ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }
      // 本地源上传（S5 联动）：本地面板 / 编辑器的文件在 host 磁盘上，浏览器拿不到字节，
      // 由后端按树根围栏读盘再推给 SFTP；进度同样走 file-progress 帧
      case 'files.uploadLocal': {
        const { sessionId, remotePath, root, path, transferId } = payload as {
          sessionId: string; remotePath: string; root: string; path: string; transferId?: string
        }
        const id = transferIdOf(transferId)
        try {
          const result = await requireFiles(deps).upload({
            sessionId,
            remotePath,
            source: { kind: 'local', ref: { root, path } },
            onProgress: (p) => deps.broadcastFileProgress?.({ kind: 'file-progress', transferId: id, ...p }),
          })
          deps.broadcastFileProgress?.({ kind: 'file-progress', transferId: id, op: 'upload', sessionId, remotePath, transferred: result.bytes, done: true, ok: true })
          return ok({ ...result, transferId: id })
        } catch (error) {
          deps.broadcastFileProgress?.({
            kind: 'file-progress', transferId: id, op: 'upload', sessionId, remotePath,
            transferred: 0, done: true, ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
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
  'PATH_OUTSIDE_ROOT', 'NOT_FOUND', 'FILE_TOO_LARGE', 'REMOTE_IO', 'UNSUPPORTED',
] as const

/** 前端生成的传输关联 id（不透明回显，≤64 字符；缺省时服务端生成）。 */
function transferIdOf(raw: string | null | undefined): string {
  const id = (raw ?? '').trim()
  if (id.length > 64) throw new FileServiceError('VALIDATION', 'transferId 过长（上限 64 字符）')
  return id.length > 0 ? id : randomUUID()
}

/** 传输路由的公共查询参数校验（upload / download 共用）。 */
function transferQueryOf(url: URL): { sessionId: string; remotePath: string; transferId: string } {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const remotePath = url.searchParams.get('remotePath') ?? ''
  if (sessionId.length === 0) throw new FileServiceError('VALIDATION', '缺少 sessionId')
  if (remotePath.length === 0) throw new FileServiceError('VALIDATION', '缺少 remotePath')
  return { sessionId, remotePath, transferId: transferIdOf(url.searchParams.get('transferId')) }
}

/** 传输路由的错误响应：NOT_FOUND → 404，其余 → 400（body 仍带错误码，前端按 code 展示）。 */
function transferErrorStatus(error: unknown): number {
  return error instanceof FileServiceError && error.code === 'NOT_FOUND' ? 404 : 400
}

/** 失败路径上尽量还原查询参数（校验失败时字段可能缺失，回显空串即可）。 */
function safeQueryOf(url: URL): { sessionId: string; remotePath: string; transferId: string } {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const remotePath = url.searchParams.get('remotePath') ?? ''
  const raw = url.searchParams.get('transferId') ?? ''
  return { sessionId, remotePath, transferId: raw.length > 0 && raw.length <= 64 ? raw : '' }
}

/** 传输路由的错误响应（Fetch 形态，已过 Connection 认证）。 */
function transferErrorResponse(error: unknown): Response {
  return Response.json({ ok: false, error: toError(error) }, { status: transferErrorStatus(error) })
}

/**
 * POST /api/term-manager/files/upload —— 浏览器直传（raw 二进制）。
 * Connection 的 streaming 路由把 Request.body 原样交给 FileService（SFTP 远端带临时文件 + rename
 * 半成品保护），不把 body 读成字符串。进度经 WS file-progress 帧广播；HTTP 响应 settle 为准（双保险）。
 */
export function createUploadFetch(deps: RemoteDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    try {
      const { sessionId, remotePath, transferId } = transferQueryOf(url)
      const rawLength = request.headers.get('content-length')
      const contentLength = rawLength === null ? Number.NaN : Number(rawLength)
      const size = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
      if (request.body === null) throw new FileServiceError('VALIDATION', '缺少上传内容')
      const result = await requireFiles(deps).upload({
        sessionId,
        remotePath,
        source: { kind: 'stream', stream: Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>), ...(size !== undefined ? { size } : {}) },
        onProgress: (p) => deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, ...p }),
      })
      deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, op: 'upload', sessionId, remotePath, transferred: result.bytes, done: true, ok: true })
      return Response.json({ ok: true, value: { ...result, transferId } })
    } catch (error) {
      const { sessionId, remotePath, transferId } = safeQueryOf(url)
      deps.broadcastFileProgress?.({
        kind: 'file-progress', transferId, op: 'upload', sessionId, remotePath,
        transferred: 0, done: true, ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return transferErrorResponse(error)
    }
  }
}

/**
 * GET /api/term-manager/files/download —— 浏览器另存为（导航式下载，可选任意本机目录）。
 * 前置 stat 在 FileService.download 里完成（不存在 → 进 404 分支，头未发）；
 * 文件名 RFC 5987 编码支持中文；no-store 防缓存。终态帧是前端唯一的完成/失败信号。
 */
export function createDownloadFetch(deps: RemoteDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    try {
      const { sessionId, remotePath, transferId } = transferQueryOf(url)
      let transferred = 0
      const { stream, size } = await requireFiles(deps).download({
        sessionId,
        remotePath,
        onProgress: (p) => {
          transferred = p.transferred
          deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, ...p })
        },
      })
      const filename = posixBasename(remotePath) || 'download'
      const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      // 传输结束时发终态帧（done=true）；响应体自行流式写出，错误时 destroy 让浏览器感知失败。
      const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
      stream.once('end', () => {
        deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, op: 'download', sessionId, remotePath, transferred, done: true, ok: true })
      })
      stream.once('error', (error: Error) => {
        deps.broadcastFileProgress?.({
          kind: 'file-progress', transferId, op: 'download', sessionId, remotePath,
          transferred, done: true, ok: false, error: error.message,
        })
      })
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          ...(size !== undefined ? { 'content-length': String(size) } : {}),
          'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
          'cache-control': 'no-store',
        },
      })
    } catch (error) {
      const { sessionId, remotePath, transferId } = safeQueryOf(url)
      deps.broadcastFileProgress?.({
        kind: 'file-progress', transferId, op: 'download', sessionId, remotePath,
        transferred: 0, done: true, ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return transferErrorResponse(error)
    }
  }
}

/** 本插件的控制面方法全集（每个方法注册一条 /api 下的精确 Fetch 路由）。 */
export const TERM_MANAGER_METHODS = [
  'connections.list', 'connections.create', 'connections.update', 'connections.remove',
  'sessions.list', 'sessions.connect', 'sessions.disconnect', 'sessions.reconnect', 'sessions.read', 'sessions.send',
  'files.tree', 'files.read', 'files.write', 'files.dirs', 'files.root', 'files.setLocalPanel', 'files.open',
  'files.remoteTree', 'files.remoteCwd', 'files.downloadToLocal', 'files.uploadLocal',
] as const

/**
 * 一条 RPC 精确 Fetch 路由：`POST /api/term-manager/<method>`。
 * 精确路由在 Typert Gateway interceptor 之前命中，因此可用 /api 的统一认证；
 * 认证、Host/Origin 栅栏由 Connection 负责（精确路由只放行 owner Peer）。
 */
export function createRpcFetch(deps: RemoteDeps, method: string): (request: Request) => Promise<Response> {
  return async (request) => {
    let rpcId = 'invalid'
    let payload: unknown = {}
    try {
      const body = await request.json() as { rpcId?: unknown; payload?: unknown }
      if (typeof body.rpcId === 'string') rpcId = body.rpcId
      payload = body.payload ?? {}
    } catch {
      return Response.json({
        type: 'server-response', rpcId,
        result: { ok: false, error: { code: 'internal', message: 'invalid JSON', details: {} } },
      }, { status: 400 })
    }
    const result = await dispatch(method, payload as Payload, deps, request.signal)
    return Response.json({ type: 'server-response', rpcId, result })
  }
}

/** 兼容旧测试/直调：endpoint 形如 `term-manager/connections.list`。 */
export function createRpcHandler(deps: RemoteDeps): (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcHandlerResult> {
  return async (endpoint, payload, signal) => {
    const method = endpoint.startsWith('term-manager/') ? endpoint.slice('term-manager/'.length) : endpoint
    return dispatch(method, (payload ?? {}) as Payload, deps, signal)
  }
}

/**
 * 把控制面挂到 DSH 统一认证的 /api 下。
 * 为什么用精确 Fetch 路由而不是 Typert/`connection.rpc.handle`：
 * - `/api` 的 Typert Gateway 只允许一个 interceptor，外部插件不能另注册；
 * - 0.2.1 的 `connection.rpc.handle` 在服务自身 ctx 上注册 webServer 路由，外部插件调用会报
 *   “cannot get property webServer without inject”；
 * - 精确 Fetch 路由是 DSH 文档给外部插件的受支持路径，且在 Gateway interceptor 之前命中。
 * 认证、Host/Origin 栅栏都由 Connection 负责，插件不再自建 CORS/loopback 判断。
 */
export function registerRemotes(ctx: Context, deps: RemoteDeps): () => void {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    console.warn('[term-manager] connection 服务不可用，remotes 未挂载')
    return () => {}
  }
  // connection.fetch.register 的 effect 挂在 Connection 服务自己的 ctx 上；这里把返回的
  // disposer 再挂到本插件 ctx，保证插件热卸载时路由一起消失（不留下指向已销毁状态的 handler）。
  const disposers: Array<() => Promise<void>> = []
  for (const method of TERM_MANAGER_METHODS) {
    disposers.push(connection.fetch.register({
      path: `/api/term-manager/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createRpcFetch(deps, method),
    }))
  }
  disposers.push(connection.fetch.register({
    path: '/api/term-manager/files/upload',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: createUploadFetch(deps),
  }))
  disposers.push(connection.fetch.register({
    path: '/api/term-manager/files/download',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: createDownloadFetch(deps),
  }))
  const disposeAll = (): void => { void Promise.all(disposers.map(dispose => dispose())) }
  ctx.effect(() => disposeAll, 'terminal-manager: /api 控制面路由')
  return disposeAll
}

/** 仅用于类型导出（前端类型生成可用）。 */
export type { ConnectionConfig, SessionSnapshot, StoreValidationError, SessionError }

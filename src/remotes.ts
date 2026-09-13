/**
 * B7a 指令通道 —— 前端控制面 RPC。
 *
 * 前端经通道①（HTTP）调用这些方法：连接配置增删改查、会话连接/断开/重连/列表/读缓冲。
 * 调度逻辑是纯函数（dispatch），便于直接测试；registerRemotes 负责挂到 ctx.webServer。
 * 挂载方式：ctx.webServer.register({ kind: 'prefix', path: '/term-manager', handler })
 * @module dsh-terminal-manager/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// 指令通道的信封类型。包名里的 client- 是上游历史命名（该包自述为「Host HTTP bridge
// for browser-client RPC」，host 侧同样可以取用；上游 host 包 packages/api/gateway 就是这么引的）。
import type { ConnectionRpcFailure, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import { basename as posixBasename } from 'node:path/posix'
import { pipeline } from 'node:stream/promises'
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

/**
 * 上游历史短名的本地别名：`@deepseek-ai/dsh-client-connection` 的包根只导出长名
 * `ConnectionRpcResult`（短名 `RpcResult` 只在它的 `/client` face 里）。下面 toError/ok
 * 的使用点保持短名。
 */
type RpcResult<T> = ConnectionRpcResult<T>

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

/** 把领域异常折叠成错误分支（code 编进 message，M4 可细化）。 */
// 注意：不能写 RpcResult<never>['error'] —— ConnectionRpcResult 是严格互斥联合，
// 成功分支没有 error 字段，索引访问取不到该属性（上游旧类型带可选 error 才能那么写）。
function toError(error: unknown): ConnectionRpcFailure {
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

/** writeJson 的小包装。 */
function respondJson(res: ServerResponse, status: number, cors: Record<string, string>, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...cors })
  res.end(JSON.stringify(body))
}

/**
 * POST /term-manager/files/upload —— 浏览器直传（XHR 发 raw 二进制）。
 * req 本体就是流，直接交给 FileService（SFTP 远端带临时文件 + rename 半成品保护）；
 * 不把 body 读成字符串。进度经 WS file-progress 帧广播；响应 settle 为准（双保险）。
 */
async function handleFileUpload(deps: RemoteDeps, req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
  try {
    const { sessionId, remotePath, transferId } = transferQueryOf(url)
    const contentLength = Number(req.headers['content-length'])
    const size = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
    const result = await requireFiles(deps).upload({
      sessionId,
      remotePath,
      source: { kind: 'stream', stream: req, ...(size !== undefined ? { size } : {}) },
      onProgress: (p) => deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, ...p }),
    })
    deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, op: 'upload', sessionId, remotePath, transferred: result.bytes, done: true, ok: true })
    respondJson(res, 200, cors, { ok: true, value: { ...result, transferId } })
  } catch (error) {
    const { sessionId, remotePath, transferId } = safeQueryOf(url)
    deps.broadcastFileProgress?.({
      kind: 'file-progress', transferId, op: 'upload', sessionId, remotePath,
      transferred: 0, done: true, ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    respondJson(res, transferErrorStatus(error), cors, { ok: false, error: toError(error) })
  }
}

/** 失败路径上尽量还原查询参数（校验失败时字段可能缺失，回显空串即可）。 */
function safeQueryOf(url: URL): { sessionId: string; remotePath: string; transferId: string } {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const remotePath = url.searchParams.get('remotePath') ?? ''
  const raw = url.searchParams.get('transferId') ?? ''
  return { sessionId, remotePath, transferId: raw.length > 0 && raw.length <= 64 ? raw : '' }
}

/**
 * GET /term-manager/files/download —— 浏览器另存为（导航式下载，可选任意本机目录）。
 * 前置 stat 在 FileService.download 里完成（不存在 → 进 404 分支，头未发）；
 * 文件名 RFC 5987 编码支持中文；no-store 防缓存。终态帧是前端唯一的完成/失败信号。
 */
async function handleFileDownload(deps: RemoteDeps, req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
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
    res.writeHead(200, {
      ...cors,
      'content-type': 'application/octet-stream',
      ...(size !== undefined ? { 'content-length': String(size) } : {}),
      'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      'cache-control': 'no-store',
    })
    await pipeline(stream, res)
    deps.broadcastFileProgress?.({ kind: 'file-progress', transferId, op: 'download', sessionId, remotePath, transferred, done: true, ok: true })
  } catch (error) {
    const { sessionId, remotePath, transferId } = safeQueryOf(url)
    deps.broadcastFileProgress?.({
      kind: 'file-progress', transferId, op: 'download', sessionId, remotePath,
      transferred: 0, done: true, ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    if (res.headersSent) {
      res.destroy() // 流已开写，只能断开（浏览器报下载失败）
      return
    }
    respondJson(res, transferErrorStatus(error), cors, { ok: false, error: toError(error) })
  }
}

/**
 * 构造 HTTP 路由 handler（便于独立测试）。
 * 返回一个 (req, res) => void 的异步函数。
 * S5 传输路由（/files/upload POST raw、/files/download GET 流式）在 JSON RPC 之前分流，
 * 与 RPC 共用 isTrustedOrigin / CORS 栅栏（单一来源，不允许绕过）。
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
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }
    // S5 文件传输路由（raw body / GET 流式），在 JSON RPC 分流之前处理
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/term-manager/files/upload') {
      if (req.method !== 'POST') {
        respondJson(res, 405, cors, { error: 'method not allowed' })
        return
      }
      await handleFileUpload(deps, req, res, url, cors)
      return
    }
    if (url.pathname === '/term-manager/files/download') {
      if (req.method !== 'GET') {
        respondJson(res, 405, cors, { error: 'method not allowed' })
        return
      }
      await handleFileDownload(deps, req, res, url, cors)
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
  } satisfies WebRoute
  // ctx.effect(fn)：fn 立即执行、其返回值是清理函数。把 register 放进 fn，
  // 返回的 disposer 才会被存为清理（而不是被立即执行删掉路由）。
  ctx.effect(() => webServer.register(route), 'terminal-manager: /term-manager 路由')
  return () => {}
}

/** 仅用于类型导出（前端类型生成可用）。 */
export type { ConnectionConfig, SessionSnapshot, StoreValidationError, SessionError }

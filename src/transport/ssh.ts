/**
 * B2 SSH 传输 —— ssh2 驱动（定案：统一 shell() 交互通道，带 PTY）。
 * MVP 阶段主机密钥不做严格校验（接受任意并继续），后续做"首次信任"（见方案 2.2 与已知风险）。
 *
 * 半死连接兜底：
 * - keepalive 30s × 3（`TM_SSH_KEEPALIVE_MS` / `TM_SSH_KEEPALIVE_COUNT` 可覆盖），黑洞连接会触发 close。
 * - 懒开 SFTP 子通道默认 30s 超时（`TM_SFTP_OPEN_TIMEOUT_MS` 可覆盖），超时不永久挂起，可重试。
 * - 连接关闭时主动 reject 仍 pending 的 SFTP open，避免文件操作无限等待。
 *
 * @module dsh-terminal-manager/transport/ssh
 */

import { Client } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import { SftpFacade } from './sftp.ts'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  TransportError,
  type SftpLike,
  type Transport,
  type TransportCallbacks,
  type TransportConnectOptions,
} from './types.ts'

interface SshErrorLike {
  message?: string
  level?: string
  code?: string
}

/** 把 ssh2 的错误映射成统一错误码（消息不含凭据）。 */
function mapSshError(err: unknown, options: TransportConnectOptions): TransportError {
  const e = (err ?? {}) as SshErrorLike
  const message = e.message ?? String(err)
  const target = `${options.host}:${options.port}`
  if (e.level === 'client-authentication' || /authentication/i.test(message)) {
    return new TransportError('AUTH_FAILED', `SSH 认证失败（用户名或密码/密钥不对）: ${target}`, { cause: err })
  }
  if (/timed out/i.test(message)) {
    return new TransportError('CONN_TIMEOUT', `连接 ${target} 超时`, { cause: err })
  }
  if (e.level === 'client-socket' || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN/.test(e.code ?? '')) {
    return new TransportError('HOST_UNREACHABLE', `无法连接 ${target}`, { cause: err })
  }
  return new TransportError('PROTO_ERROR', `SSH 协议错误: ${message}`, { cause: err })
}

/** SFTP 子通道开关超时默认值：30 秒（半死连接下 ssh2 的 conn.sftp 可能永远不回调）。 */
export const DEFAULT_SFTP_OPEN_TIMEOUT_MS = 30_000
/** SSH keepalive 间隔默认 30 秒。 */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
/** SSH keepalive 连续无响应次数上限默认 3。 */
export const DEFAULT_KEEPALIVE_COUNT_MAX = 3

export interface SshRuntimeSettings {
  sftpOpenTimeoutMs: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
}

/** 读正整数环境变量；非法（空/负数/小数/NaN）回退默认值。 */
function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return fallback
  return value
}

/** 解析 SSH 运行时参数（测试可传 env；生产默认 process.env）。 */
export function resolveSshSettings(env: NodeJS.ProcessEnv = process.env): SshRuntimeSettings {
  return {
    sftpOpenTimeoutMs: readPositiveInt(env, 'TM_SFTP_OPEN_TIMEOUT_MS', DEFAULT_SFTP_OPEN_TIMEOUT_MS),
    keepaliveIntervalMs: readPositiveInt(env, 'TM_SSH_KEEPALIVE_MS', DEFAULT_KEEPALIVE_INTERVAL_MS),
    keepaliveCountMax: readPositiveInt(env, 'TM_SSH_KEEPALIVE_COUNT', DEFAULT_KEEPALIVE_COUNT_MAX),
  }
}

/** 测试注入点：默认用真实 ssh2 Client / process.env。 */
export interface SshTransportDeps {
  createClient?: () => Client
  env?: NodeJS.ProcessEnv
}

/** 建立一条 SSH 交互通道。失败抛 TransportError。 */
export function connectSsh(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
  terminal: { cols: number; rows: number } = { cols: 120, rows: 32 },
  deps: SshTransportDeps = {},
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const settings = resolveSshSettings(deps.env ?? process.env)
  return new Promise<Transport>((resolve, reject) => {
    const conn = deps.createClient !== undefined ? deps.createClient() : new Client()
    let settled = false
    let connected = false // 连接是否成功建立
    let closed = false
    let stream: ClientChannel | undefined
    // SFTP 子通道按连接复用（审查 H1：每操作新开一条且不关，真实 OpenSSH MaxSessions(默认 10) 几次就耗尽）
    let sftpPromise: Promise<SftpLike> | undefined
    let sftpRaw: SFTPWrapper | undefined
    // 仍 pending 的 SFTP open rejector：连接关闭时统一 reject，避免调用方无限等待
    const pendingSftpRejects = new Set<(error: TransportError) => void>()

    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      conn.end()
      reject(mapSshError(err, options))
    }

    const cleanupPendingSftp = (): void => {
      const pending = [...pendingSftpRejects]
      pendingSftpRejects.clear()
      for (const rejectPending of pending) {
        rejectPending(new TransportError('DISCONNECTED', 'SSH 连接已断开，SFTP 打开被取消'))
      }
      sftpPromise = undefined
      sftpRaw = undefined
    }

    const finishClose = (reason: string): void => {
      // 只有在连接成功建立后才调用 onClose
      // 避免连接失败时触发 handleClose 导致幽灵会话
      if (closed || !connected) return
      closed = true
      callbacks.onClose(reason)
    }

    // 用 on 而不是 once：连接建立后的错误（如断线）也需要捕获，
    // 否则 Node.js 会因 unhandled 'error' event 崩溃进程
    conn.on('error', (err: unknown) => {
      if (!settled) {
        // 连接阶段：reject promise
        fail(err)
      } else {
        // 连接已建立后：半死连接可能只报错不 close，先把 pending 的 SFTP open 兜底 reject
        cleanupPendingSftp()
      }
    })
    conn.on('close', () => {
      cleanupPendingSftp()
      finishClose('SSH 连接关闭')
    })

    conn.once('ready', () => {
      connected = true // 标记连接已成功建立
      conn.shell(
        { term: 'xterm-256color', cols: terminal.cols, rows: terminal.rows },
        (err, channel) => {
          if (err) {
            fail(err)
            return
          }
          if (settled) {
            channel.close()
            return
          }
          settled = true
          stream = channel
          channel.on('data', (chunk: Buffer) => callbacks.onData(chunk.toString('utf8')))
          channel.stderr.on('data', (chunk: Buffer) => callbacks.onData(chunk.toString('utf8')))
          channel.on('close', () => {
            cleanupPendingSftp()
            finishClose('SSH 通道关闭')
            conn.end()
          })
          resolve({
            write: (data: string) => {
              if (!closed) channel.write(data)
            },
            resize: (cols: number, rows: number) => {
              if (!closed) channel.setWindow(rows, cols, 0, 0)
            },
            // 懒开 sftp 子通道并复用（并发操作共享同一条子通道，SFTP 协议支持多路请求）；
            // 打开失败不缓存（设备未开子系统可重试），通道自行死亡时失效缓存下次重开
            getSftp: () => {
              if (closed) return Promise.reject(new TransportError('DISCONNECTED', 'SSH 连接已断开，无法打开 SFTP'))
              if (sftpPromise !== undefined) return sftpPromise
              const promise = new Promise<SftpLike>((resolveSftp, rejectSftp) => {
                let done = false
                let timer: ReturnType<typeof setTimeout> | undefined

                const rejectOnce = (error: TransportError): void => {
                  if (done) return
                  done = true
                  if (timer !== undefined) clearTimeout(timer)
                  pendingSftpRejects.delete(rejectOnce)
                  rejectSftp(error)
                }

                timer = setTimeout(() => {
                  // 半死连接：ssh2 的 sftp 回调可能永远不来。超时后清缓存，后续调用可重试。
                  rejectOnce(new TransportError(
                    'PROTO_ERROR',
                    `打开 SFTP 子通道超时（${settings.sftpOpenTimeoutMs}ms）`,
                  ))
                }, settings.sftpOpenTimeoutMs)
                pendingSftpRejects.add(rejectOnce)

                conn.sftp((sftpErr, sftp) => {
                  if (done) {
                    // 超时/断线后才姗姗来迟的子通道：直接关掉，避免泄漏
                    try { sftp?.end() } catch { /* 尽力而为 */ }
                    return
                  }
                  done = true
                  if (timer !== undefined) clearTimeout(timer)
                  pendingSftpRejects.delete(rejectOnce)
                  if (sftpErr) {
                    // 等回调期间断线也按 DISCONNECTED 报；其余（如设备未开 sftp 子系统）归 PROTO_ERROR
                    rejectSftp(
                      closed
                        ? new TransportError('DISCONNECTED', 'SSH 连接已断开，无法打开 SFTP')
                        : new TransportError('PROTO_ERROR', `打开 SFTP 子通道失败: ${sftpErr.message}`, { cause: sftpErr }),
                    )
                    return
                  }
                  sftpRaw = sftp
                  sftp.on('close', () => { sftpPromise = undefined; sftpRaw = undefined })
                  resolveSftp(new SftpFacade(sftp))
                })
              })
              // 统一在 catch 里清缓存：成功结果复用，失败（超时/断线/子系统没开）下次可重试。
              // 这样即使 conn.sftp 同步回调失败，也不会把 rejected promise 永久缓存住。
              const guarded = promise.catch((error: unknown) => {
                sftpPromise = undefined
                throw error
              })
              sftpPromise = guarded
              return guarded
            },
            close: async () => {
              finishClose('本端主动断开')
              const rawSftp = sftpRaw
              cleanupPendingSftp()
              rawSftp?.end()
              channel.close()
              conn.end()
            },
          })
        },
      )
    })

    conn.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      readyTimeout: timeoutMs,
      // 半死连接兜底：定期 keepalive，连续无响应 3 次让 ssh2 关闭连接（触发 close/error）
      keepaliveInterval: settings.keepaliveIntervalMs,
      keepaliveCountMax: settings.keepaliveCountMax,
      // MVP：接受任意主机密钥（风险已记录，后续做首次信任）
      hostVerifier: () => true,
      ...(options.auth?.kind === 'password' ? { password: options.auth.password } : {}),
      ...(options.auth?.kind === 'key' ? { privateKey: options.auth.privateKey, ...(options.auth.passphrase !== undefined ? { passphrase: options.auth.passphrase } : {}) } : {}),
    })
  })
}

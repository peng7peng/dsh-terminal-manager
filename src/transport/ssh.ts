/**
 * B2 SSH 传输 —— ssh2 驱动（定案：统一 shell() 交互通道，带 PTY）。
 * MVP 阶段主机密钥不做严格校验（接受任意并继续），后续做"首次信任"（见方案 2.2 与已知风险）。
 * @module dsh-terminal-manager/transport/ssh
 */

import { Client } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  TransportError,
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

/** 建立一条 SSH 交互通道。失败抛 TransportError。 */
export function connectSsh(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
  terminal: { cols: number; rows: number } = { cols: 120, rows: 32 },
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  return new Promise<Transport>((resolve, reject) => {
    const conn = new Client()
    let settled = false
    let connected = false // 连接是否成功建立
    let closed = false
    let stream: ClientChannel | undefined

    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      conn.end()
      reject(mapSshError(err, options))
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
      }
      // 连接已建立后：finishClose 处理（不调 onClose 因为 connected 检查）
      // 错误被捕获即可，不需要额外操作
    })
    conn.on('close', () => finishClose('SSH 连接关闭'))

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
            // 懒开 sftp 子通道：conn 引用从连接期到连接后一直持有，随时可复用同一 Client 开新子通道
            getSftp: () =>
              new Promise<SFTPWrapper>((resolveSftp, rejectSftp) => {
                if (closed) {
                  rejectSftp(new TransportError('DISCONNECTED', 'SSH 连接已断开，无法打开 SFTP'))
                  return
                }
                conn.sftp((err, sftp) => {
                  if (err) {
                    // 等回调期间断线也按 DISCONNECTED 报；其余（如设备未开 sftp 子系统）归 PROTO_ERROR
                    rejectSftp(
                      closed
                        ? new TransportError('DISCONNECTED', 'SSH 连接已断开，无法打开 SFTP')
                        : new TransportError('PROTO_ERROR', `打开 SFTP 子通道失败: ${err.message}`, { cause: err }),
                    )
                    return
                  }
                  resolveSftp(sftp)
                })
              }),
            close: async () => {
              finishClose('本端主动断开')
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
      // MVP：接受任意主机密钥（风险已记录，后续做首次信任）
      hostVerifier: () => true,
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.privateKey !== undefined ? { privateKey: options.privateKey } : {}),
      ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
    })
  })
}

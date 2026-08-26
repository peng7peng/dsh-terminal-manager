/**
 * B2 SSH 传输 —— ssh2 驱动（定案：统一 shell() 交互通道，带 PTY）。
 * MVP 阶段主机密钥不做严格校验（接受任意并继续），后续做"首次信任"（见方案 2.2 与已知风险）。
 * @module dsh-terminal-manager/transport/ssh
 */

import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
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
    let closed = false
    let stream: ClientChannel | undefined

    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      conn.end()
      reject(mapSshError(err, options))
    }

    const finishClose = (reason: string): void => {
      if (closed) return
      closed = true
      callbacks.onClose(reason)
    }

    conn.once('error', fail)
    conn.on('close', () => finishClose('SSH 连接关闭'))

    conn.once('ready', () => {
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

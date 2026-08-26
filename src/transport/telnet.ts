/**
 * B3 Telnet 传输 —— 裸 TCP 实现（定案见方案 2.2：目标设备以网络设备/ESL 为主）。
 * 协议协商接缝已留：若个别设备回显异常，可在不改上层的前提下换协商实现。
 * @module dsh-terminal-manager/transport/telnet
 */

import * as net from 'node:net'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  TransportError,
  type Transport,
  type TransportCallbacks,
  type TransportConnectOptions,
} from './types.ts'

/** 建立一条裸 TCP 连接。失败抛 TransportError。 */
export function connectTelnet(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  return new Promise<Transport>((resolve, reject) => {
    let settled = false
    const socket = net.connect({ host: options.host, port: options.port })
    socket.setEncoding('utf8')

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new TransportError('CONN_TIMEOUT', `连接 ${options.host}:${options.port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      let closed = false
      const finishClose = (reason: string): void => {
        if (closed) return
        closed = true
        callbacks.onClose(reason)
      }
      socket.on('data', (chunk) => callbacks.onData(chunk as string))
      socket.on('error', (error) => {
        // 连接建立后的错误按掉线处理（建立前的错误由下方 once('error') 拒绝）
        finishClose(`连接错误: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
        socket.destroy()
      })
      socket.on('close', () => finishClose('对端关闭或连接断开'))
      resolve({
        write: (data: string) => {
          if (!closed) socket.write(data)
        },
        close: async () => {
          finishClose('本端主动断开')
          socket.destroy()
        },
      })
    })

    socket.once('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const code = (error as NodeJS.ErrnoException).code
      reject(new TransportError('HOST_UNREACHABLE', `无法连接 ${options.host}:${options.port}（${code ?? error.message}）`, { cause: error }))
    })
  })
}

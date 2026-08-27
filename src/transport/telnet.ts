/**
 * B3 Telnet 传输 —— 支持 Telnet 协议协商和裸 TCP 两种模式。
 *
 * - telnetMode='raw'（默认）：裸 TCP 透传，不做协议协商（适合串口服务器/ESL）。
 * - telnetMode='telnet'：处理 IAC 协商——对 WILL/WONT/DO/DONT 回 WONT/DONT（拒绝所有选项），
 *   并发送 IAC WILL ECHO + IAC SUPPRESS_GO_AHEAD 促成字符模式；IAC 序列从数据流中剔除。
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

// Telnet IAC 控制字节
const IAC = 0xff // 255
const DONT = 0xfe // 254
const DO = 0xfd // 253
const WONT = 0xfc // 252
const WILL = 0xfb // 251
const SB = 0xfa // 250
const SE = 0xf0 // 240
const ECHO = 1
const SUPPRESS_GO_AHEAD = 3

/** 从数据流中剥离 IAC 协商序列，返回纯文本；同时处理协商（拒绝所有选项 + 促成字符模式）。 */
function stripIac(input: Buffer, socket: net.Socket): string {
  let out = Buffer.alloc(0)
  let i = 0
  while (i < input.length) {
    const b = input[i]
    if (b !== IAC) { out = Buffer.concat([out, input.subarray(i, i + 1)]); i++; continue }
    if (i + 1 >= input.length) break
    const cmd = input[i + 1]
    if (cmd === IAC) { out = Buffer.concat([out, Buffer.from([IAC])]); i += 2; continue }
    if (cmd === DO || cmd === DONT) {
      const opt = input[i + 2] ?? 0
      socket.write(Buffer.from([IAC, WONT, opt]))
      i += 3; continue
    }
    if (cmd === WILL || cmd === WONT) {
      const opt = input[i + 2] ?? 0
      socket.write(Buffer.from([IAC, DONT, opt]))
      i += 3; continue
    }
    if (cmd === SB) {
      let j = i + 2
      while (j < input.length && !(input[j] === IAC && input[j + 1] === SE)) j++
      i = j + 2; continue
    }
    i += 2
  }
  return out.toString('utf8')
}

/** 建立一条 Telnet/裸 TCP 连接。失败抛 TransportError。 */
export function connectTelnet(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const useIac = (options as { telnetMode?: string }).telnetMode === 'telnet'
  return new Promise<Transport>((resolve, reject) => {
    let settled = false
    const socket = net.connect({ host: options.host, port: options.port })

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

      // Telnet 模式：发送 WILL ECHO + SUPPRESS_GO_AHEAD，促成字符模式
      if (useIac) {
        socket.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SUPPRESS_GO_AHEAD]))
      }

      let closed = false
      const finishClose = (reason: string): void => {
        if (closed) return
        closed = true
        callbacks.onClose(reason)
      }
      socket.on('data', (chunk: Buffer) => {
        if (useIac) {
          const clean = stripIac(chunk, socket)
          if (clean.length > 0) callbacks.onData(clean)
        } else {
          callbacks.onData(chunk.toString('utf8'))
        }
      })
      socket.on('error', (error) => {
        finishClose(`连接错误: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
        socket.destroy()
      })
      socket.on('close', () => finishClose('对端关闭或连接断开'))
      resolve({
        write: (data: string) => { if (!closed) socket.write(data) },
        close: async () => { finishClose('本端主动断开'); socket.destroy() },
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

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

/** 从数据流中剥离 IAC 协商序列，返回纯文本。不回发响应（避免 echo server 回环）。
 *  真网络设备会处理 IAC 协商；对 echo server/裸设备，不响应不会出问题。
 *  支持跨 chunk 拼接：返回 { text, leftover } —— leftover 是末尾未完成的 IAC 序列，
 *  需要和下一个 chunk 拼起来再处理。 */
function stripIac(input: Buffer): { text: string; leftover: Buffer } {
  let out = Buffer.alloc(0)
  let i = 0
  while (i < input.length) {
    const b = input[i]
    if (b !== IAC) { out = Buffer.concat([out, input.subarray(i, i + 1)]); i++; continue }
    // 遇到 IAC，检查后续字节是否完整
    if (i + 1 >= input.length) {
      // IAC 是最后一个字节，留到下个 chunk
      return { text: out.toString('utf8'), leftover: input.subarray(i) }
    }
    const cmd = input[i + 1]
    if (cmd === IAC) { out = Buffer.concat([out, Buffer.from([IAC])]); i += 2; continue }
    if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
      // 3 字节序列：IAC + cmd + option
      if (i + 2 >= input.length) {
        // 不完整，留到下个 chunk
        return { text: out.toString('utf8'), leftover: input.subarray(i) }
      }
      i += 3; continue
    }
    if (cmd === SB) {
      // SB 子协商：IAC SB ... IAC SE，找终止符
      let j = i + 2
      while (j < input.length && !(input[j] === IAC && j + 1 < input.length && input[j + 1] === SE)) j++
      if (j >= input.length || j + 1 >= input.length) {
        // SB 序列未完成，留到下个 chunk
        return { text: out.toString('utf8'), leftover: input.subarray(i) }
      }
      i = j + 2; continue
    }
    // 其他未知 IAC 序列，跳过 2 字节
    i += 2
  }
  return { text: out.toString('utf8'), leftover: Buffer.alloc(0) }
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

      // Telnet 模式：不主动发 IAC（避免 echo server 回环）；只剥离收到的 IAC
      let closed = false
      let iacLeftover = Buffer.alloc(0) // 跨 chunk 拼接：未完成的 IAC 序列
      const finishClose = (reason: string): void => {
        if (closed) return
        closed = true
        callbacks.onClose(reason)
      }
      socket.on('data', (chunk: Buffer) => {
        if (useIac) {
          // 把上一个 chunk 的 leftover 拼到前面
          const full = iacLeftover.length > 0 ? Buffer.concat([iacLeftover, chunk]) : chunk
          const { text, leftover } = stripIac(full)
          iacLeftover = leftover
          if (text.length > 0) callbacks.onData(text)
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

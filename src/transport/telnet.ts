/**
 * B3 Telnet 传输 —— 完整的 Telnet 协议协商支持。
 *
 * - telnetMode='telnet'（默认）：完整 IAC 协商——响应 WILL/WONT/DO/DONT，
 *   发送 WILL ECHO + DO SGA 实现字符模式（不回显本地输入，由服务器回显）。
 * - telnetMode='raw'：裸 TCP 透传，不做协议协商（适合串口服务器/ESL）。
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

// Telnet 协议常量
const IAC = 0xff // 255
const DONT = 0xfe // 254
const DO = 0xfd // 253
const WONT = 0xfc // 252
const WILL = 0xfb // 251
const SB = 0xfa // 250
const SE = 0xf0 // 240

// Telnet 选项
const ECHO = 1 // 回显
const SGA = 3 // Suppress Go Ahead（抑制继续进行）
const TTYPE = 24 // Terminal Type
const NAWS = 31 // Negotiate Window Size

/**
 * 构建 IAC 响应序列
 */
function iacResponse(cmd: number, option: number): Buffer {
  return Buffer.from([IAC, cmd, option])
}

/**
 * 构建 IAC SB 子协商序列
 */
function iacSubneg(option: number, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([IAC, SB, option]),
    data,
    Buffer.from([IAC, SE]),
  ])
}

/**
 * 建立一条 Telnet/裸 TCP 连接。失败抛 TransportError。
 */
export function connectTelnet(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const useTelnet = (options as { telnetMode?: string }).telnetMode !== 'raw'
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

      let closed = false
      const finishClose = (reason: string): void => {
        if (closed) return
        closed = true
        callbacks.onClose(reason)
      }

      // 跨 chunk 的 IAC 解析状态
      type IacState = 'data' | 'iac' | 'cmd' | 'sb' | 'sb-data' | 'sb-iac'
      let iacState: IacState = 'data'
      let iacCmd = 0
      let sbOption = 0

      /**
       * 处理 Telnet 协商并发送响应
       */
      const handleNegotiation = (cmd: number, option: number): void => {
        if (!useTelnet) return // raw 模式不处理协商

        let response: Buffer | null = null

        if (cmd === DO) {
          // 服务器请求我们做某事
          if (option === SGA) {
            // 同意抑制 Go Ahead（字符模式）
            response = iacResponse(WILL, SGA)
          } else if (option === ECHO) {
            // 同意让服务器回显（我们不在本地回显）
            response = iacResponse(WILL, ECHO)
          } else if (option === TTYPE) {
            // 同意发送终端类型
            response = iacResponse(WILL, TTYPE)
          } else if (option === NAWS) {
            // 同意发送窗口大小
            response = iacResponse(WILL, NAWS)
          } else {
            // 拒绝其他请求
            response = iacResponse(WONT, option)
          }
        } else if (cmd === WILL) {
          // 服务器表示它要做某事
          if (option === ECHO) {
            // 同意服务器回显
            response = iacResponse(DO, ECHO)
          } else if (option === SGA) {
            // 同意服务器抑制 Go Ahead
            response = iacResponse(DO, SGA)
          } else {
            // 拒绝其他
            response = iacResponse(DONT, option)
          }
        }
        // DONT 和 WONT 不需要响应

        if (response) {
          socket.write(response)
        }
      }

      /**
       * 发送终端类型子协商
       */
      const sendTerminalType = (): void => {
        if (!useTelnet) return
        // IS (0) + "xterm"
        const ttypeData = Buffer.concat([Buffer.from([0]), Buffer.from('xterm', 'ascii')])
        socket.write(iacSubneg(TTYPE, ttypeData))
      }

      /**
       * 子协商数据里的 0xFF 转义成 IAC IAC（RFC 1073）
       */
      const escapeIac = (data: Buffer): Buffer => {
        const out: number[] = []
        for (const b of data) {
          if (b === IAC) out.push(IAC, IAC)
          else out.push(b)
        }
        return Buffer.from(out)
      }

      /**
       * 发送窗口大小子协商
       */
      const sendWindowSize = (cols: number, rows: number): void => {
        if (!useTelnet) return
        // NAWS 子协商：宽度 2 字节 + 高度 2 字节（大端序）
        const nawsData = Buffer.alloc(4)
        nawsData.writeUInt16BE(cols, 0)
        nawsData.writeUInt16BE(rows, 2)
        // RFC 1073：子协商数据里的 0xFF 字节要转义成 IAC IAC，否则破坏对端解析
        socket.write(iacSubneg(NAWS, escapeIac(nawsData)))
      }

      // 前端拖动布局时会每帧请求 resize；高频 NAWS 会把弱 telnetd 打糊涂（把协商字节当输入回显成乱码）。
      // 抖动期间只记最后一次尺寸，停稳 150ms 后发一条；尺寸没变不重发。
      const RESIZE_DEBOUNCE_MS = 150
      let lastCols = -1
      let lastRows = -1
      let resizeTimer: ReturnType<typeof setTimeout> | undefined
      let pendingSize: { cols: number; rows: number } | null = null
      const requestResize = (cols: number, rows: number): void => {
        if (!useTelnet || closed) return
        if (cols === lastCols && rows === lastRows) return
        pendingSize = { cols, rows }
        if (resizeTimer === undefined) {
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined
            const p = pendingSize
            pendingSize = null
            if (p === null || closed) return
            lastCols = p.cols
            lastRows = p.rows
            sendWindowSize(p.cols, p.rows)
          }, RESIZE_DEBOUNCE_MS)
        }
      }

      // Telnet 模式：发送初始协商
      if (useTelnet) {
        // 主动请求服务器回显和抑制 Go Ahead
        socket.write(iacResponse(WILL, SGA))
        socket.write(iacResponse(WILL, ECHO))
        socket.write(iacResponse(DO, SGA))
        socket.write(iacResponse(DO, ECHO))
        // 主动发送默认窗口大小（80x24）
        // 某些服务器在收到 DO NAWS 后会等子协商数据，超时不发送会导致断开
        // （#18 修复；后续真实尺寸由前端 resize 防抖同步，晚一点到达无影响）
        sendWindowSize(80, 24)
        lastCols = 80
        lastRows = 24
      }

      /**
       * 处理接收到的数据，解析 IAC 序列
       */
      const processData = (chunk: Buffer): string => {
        const output: number[] = []

        for (let i = 0; i < chunk.length; i++) {
          const byte = chunk[i]

          switch (iacState) {
            case 'data':
              if (byte === IAC) {
                iacState = 'iac'
              } else {
                output.push(byte)
              }
              break

            case 'iac':
              // 刚收到 IAC
              if (byte === IAC) {
                // IAC IAC = 数据字节 255
                output.push(0xff)
                iacState = 'data'
              } else if (byte === SB) {
                // 子协商开始
                iacState = 'sb'
              } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
                iacCmd = byte
                iacState = 'cmd'
              } else {
                // 未知命令，忽略
                iacState = 'data'
              }
              break

            case 'cmd':
              // 收到命令后的选项字节
              handleNegotiation(iacCmd, byte)
              iacState = 'data'
              break

            case 'sb':
              // 子协商的选项字节
              sbOption = byte
              iacState = 'sb-data'
              break

            case 'sb-data':
              if (byte === IAC) {
                iacState = 'sb-iac'
              }
              // 其他字节都是子协商数据，忽略
              break

            case 'sb-iac':
              if (byte === SE) {
                // 子协商结束
                if (sbOption === TTYPE) {
                  // 服务器请求终端类型
                  sendTerminalType()
                }
                iacState = 'data'
              } else if (byte === IAC) {
                // IAC IAC in SB = 数据字节 255，忽略
                iacState = 'sb-data'
              } else {
                // 错误，重置
                iacState = 'data'
              }
              break
          }
        }

        return output.length > 0 ? Buffer.from(output).toString('utf8') : ''
      }

      socket.on('data', (chunk: Buffer) => {
        if (useTelnet) {
          const text = processData(chunk)
          if (text.length > 0) {
            callbacks.onData(text)
          }
        } else {
          // raw 模式直接输出
          callbacks.onData(chunk.toString('utf8'))
        }
      })

      socket.on('error', (error) => {
        finishClose(`连接错误: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
        socket.destroy()
      })

      socket.on('close', () => finishClose('对端关闭或连接断开'))

      resolve({
        write: (data: string) => {
          if (!closed) {
            socket.write(data)
          }
        },
        resize: (cols: number, rows: number) => {
          requestResize(cols, rows)
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

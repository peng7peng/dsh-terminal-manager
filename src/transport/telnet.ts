/**
 * B3 Telnet 传输 —— 三档模式：passive（默认）/ active / raw。
 *
 * - passive（默认）：连接后不主动发协商，只回应服务器发来的 WILL/WONT/DO/DONT；
 *   TTYPE / NAWS 在服务器请求时回；输入不做 0xFF 转义（除非已确认是真 telnetd）。
 * - active：连接后发 1 条 DO SGA 并开 800ms 探测窗口——收到合法 IAC 判真 telnetd；
 *   收到非 IAC 数据立即切被动（裸 shell，不再主动协商）；超时保守按 telnetd 继续。
 * - raw：纯 TCP 透传，不解析 IAC、不协商、不转义（串口服务器 / ESL）。
 * - 旧值 `'telnet'` 归一化为 `'active'`；缺省归一化为 `'passive'`。
 *
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
import {
  DO,
  NAWS,
  TELNET_PROBE_MS,
  TelnetNegotiator,
  TelnetStreamParser,
  buildNaws,
  escapeUserInput,
  initialNegotiation,
  normalizeTelnetMode,
  type TelnetMode,
} from './telnet-codec.ts'

export type { TelnetMode } from './telnet-codec.ts'
export { normalizeTelnetMode } from './telnet-codec.ts'

// 前端拖动布局时会每帧请求 resize；高频 NAWS 会把弱 telnetd 打糊涂（把协商字节当输入回显成乱码）。
// 抖动期间只记最后一次尺寸，停稳 150ms 后发一条；尺寸没变不重发。
const RESIZE_DEBOUNCE_MS = 150

/** 建立一条 Telnet/裸 TCP 连接。失败抛 TransportError。 */
export function connectTelnet(
  options: TransportConnectOptions,
  callbacks: TransportCallbacks,
): Promise<Transport> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const mode: TelnetMode = normalizeTelnetMode((options as { telnetMode?: unknown }).telnetMode)
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
      // active 探测：窗口内未见 IAC 且收到数据 → 判裸 shell；超时 → 保守按 telnetd
      let probePending = mode === 'active'
      let probeTimer: ReturnType<typeof setTimeout> | undefined
      let confirmed = false // 已确认/保守判定为真 telnetd（决定输入 0xFF 是否转义）
      let bareShell = false // active 探测中发现对端不是 telnetd，退化为被动

      // 窗口大小状态：-1 表示还没发过
      let lastCols = -1
      let lastRows = -1
      let resizeTimer: ReturnType<typeof setTimeout> | undefined
      let pendingSize: { cols: number; rows: number } | null = null

      const clearProbeTimer = (): void => {
        if (probeTimer !== undefined) {
          clearTimeout(probeTimer)
          probeTimer = undefined
        }
      }

      const finishClose = (reason: string): void => {
        if (closed) return
        closed = true
        clearProbeTimer()
        if (resizeTimer !== undefined) {
          clearTimeout(resizeTimer)
          resizeTimer = undefined
        }
        callbacks.onClose(reason)
      }

      // 协商器只在 passive/active 下存在；raw 完全绕过
      const negotiator = mode === 'raw' ? undefined : new TelnetNegotiator()

      const sendWindowSize = (cols: number, rows: number): void => {
        if (closed || mode === 'raw') return
        lastCols = cols
        lastRows = rows
        socket.write(buildNaws(cols, rows))
      }

      /** 当前能否发 NAWS：passive 必须等服务器 DO NAWS；active 探测确认后即可。 */
      const canSendNaws = (): boolean => {
        if (mode === 'raw' || bareShell) return false
        if (negotiator?.localEnabled(NAWS) === true) return true
        return mode === 'active' && confirmed
      }

      /**
       * active 的初始窗口大小：探测出结果后再发（避免把 NAWS 字节糊到裸 shell 里）。
       * 服务器先 DO NAWS 时由命令分支立即回，不会重复。
       */
      const sendInitialWindowSize = (): void => {
        if (mode === 'active' && !bareShell && lastCols < 0) sendWindowSize(80, 24)
      }

      /** 收到任意合法 IAC：确认是真 telnetd，结束探测。 */
      const confirmTelnetd = (): void => {
        probePending = false
        clearProbeTimer()
        confirmed = true
        negotiator?.markConfirmed()
      }

      const parser = negotiator === undefined
        ? undefined
        : new TelnetStreamParser({
          onData: (data) => {
            if (data.length === 0) return
            // active 探测窗口内先收到普通数据 → 裸 shell / 串口，立即退化为被动
            if (probePending) {
              probePending = false
              clearProbeTimer()
              bareShell = true
            }
            callbacks.onData(data.toString('utf8'))
          },
          onCommand: (cmd, option) => {
            if (closed || negotiator === undefined) return
            confirmTelnetd()
            for (const response of negotiator.handleCommand(cmd, option)) socket.write(response)
            // 服务器请求 NAWS：先回 WILL，再补一条当前尺寸（首次用 80x24）
            if (cmd === DO && option === NAWS && negotiator.localEnabled(NAWS)) {
              sendWindowSize(lastCols < 0 ? 80 : lastCols, lastRows < 0 ? 24 : lastRows)
            }
            sendInitialWindowSize()
          },
          onSubnegotiation: (option, data) => {
            if (closed || negotiator === undefined) return
            confirmTelnetd()
            for (const response of negotiator.handleSubnegotiation(option, data)) socket.write(response)
            sendInitialWindowSize()
          },
        })

      const requestResize = (cols: number, rows: number): void => {
        if (mode === 'raw' || closed) return
        if (cols === lastCols && rows === lastRows) return
        pendingSize = { cols, rows }
        if (resizeTimer === undefined) {
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined
            const size = pendingSize
            pendingSize = null
            if (size === null || closed || !canSendNaws()) return
            sendWindowSize(size.cols, size.rows)
          }, RESIZE_DEBOUNCE_MS)
        }
      }

      // 初始协商：active 发 1 条 DO SGA；passive/raw 什么都不发
      for (const frame of initialNegotiation(mode)) socket.write(frame)
      if (mode === 'active') {
        probeTimer = setTimeout(() => {
          probeTimer = undefined
          if (closed || !probePending) return
          // 超时保守判真 telnetd（宁可多发几条协商，也不让真设备卡在探测里）
          confirmTelnetd()
          sendInitialWindowSize()
        }, TELNET_PROBE_MS)
      }

      socket.on('data', (chunk: Buffer) => {
        if (closed) return
        if (parser === undefined) {
          // raw 模式直接输出
          callbacks.onData(chunk.toString('utf8'))
        } else {
          parser.feed(chunk)
        }
      })

      socket.on('error', (error) => {
        finishClose(`连接错误: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
        socket.destroy()
      })

      socket.on('close', () => finishClose('对端关闭或连接断开'))

      resolve({
        write: (data: string) => {
          if (closed) return
          const bytes = Buffer.from(data, 'utf8')
          // 只有确认/激活的 telnetd 才需要把用户输入里的裸 0xFF 双写；裸 shell 原样透传
          socket.write(confirmed && mode !== 'raw' ? escapeUserInput(bytes) : bytes)
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

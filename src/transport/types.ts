/**
 * 传输层接口 —— 与协议无关的"一条能读写的连接"。
 * B2（SSH）与 B3（Telnet）各自实现；未来的串口（SerialTransport）实现同一接口即可。
 * 传输层只被 B4 会话管理器接触。
 * @module dsh-terminal-manager/transport/types
 */

/** 统一的错误码（与方案 3.6 错误码约定一致）。 */
export type TransportErrorCode =
  | 'AUTH_FAILED'
  | 'HOST_UNREACHABLE'
  | 'CONN_TIMEOUT'
  | 'PROTO_ERROR'
  | 'DISCONNECTED'

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** 一条活跃连接的回调。 */
export interface TransportCallbacks {
  /** 设备输出（已按 UTF-8 解码） */
  onData: (chunk: string) => void
  /** 连接终结（含原因：设备掉线、本端关闭等） */
  onClose: (reason: string) => void
}

/** 建立连接共用的参数（协议各自的字段按可选传入）。 */
export interface TransportConnectOptions {
  host: string
  port: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** 连接建立超时，默认 15 秒 */
  connectTimeoutMs?: number
  /** Telnet 模式：'telnet'（IAC 协商）| 'raw'（裸 TCP，默认） */
  telnetMode?: 'telnet' | 'raw'
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** 一条活跃连接。 */
export interface Transport {
  /** 向设备写入（命令文本/按键） */
  write(data: string): void
  /** 调整终端尺寸（SSH 生效；Telnet 无操作） */
  resize?(cols: number, rows: number): void
  /** 关闭并等待资源释放（幂等） */
  close(): Promise<void>
}

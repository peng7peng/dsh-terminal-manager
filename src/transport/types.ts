/**
 * 传输层接口 —— 与协议无关的"一条能读写的连接"。
 * B2（SSH）与 B3（Telnet）各自实现；未来的串口（SerialTransport）实现同一接口即可。
 * 传输层只被 B4 会话管理器接触。
 * @module dsh-terminal-manager/transport/types
 */

import type { Readable } from 'node:stream'
import type { FileEntry } from '../types/file-service.ts'

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

// ── SFTP 门面接口（S5，协议无关）──────────────────────────

/** 进度回调：transferred 为已传输字节；total 未知时缺省 */
export type SftpProgress = (transferred: number, total?: number) => void

/** 单个路径的信息（lstat 语义：符号链接本身，不跟随） */
export interface SftpStatInfo {
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
  size?: number
  mtimeMs?: number
}

/** 上传来源：本地绝对路径（fastPut）或已打开的流（浏览器直传） */
export type SftpPutSource =
  | { kind: 'path'; path: string }
  | { kind: 'stream'; stream: Readable; size?: number }

export interface SftpTransferOptions {
  onProgress?: SftpProgress
  /** 已知大小超限时抛 FILE_TOO_LARGE；不传即不限 */
  maxBytes?: number
}

/**
 * 协议无关的 SFTP 门面接口（传输层不暴露 ssh2 类型；串口等未来实现同一接口即可）。
 * SshTransport 返回 `SftpFacade`（`transport/sftp.ts`，包 ssh2 SFTPWrapper）；
 * Telnet 不实现——远端文件操作对 Telnet 会话抛 UNSUPPORTED（由 FileService 按协议分派）。
 */
export interface SftpLike {
  /** 列一层目录（readdir 属性，符号链接不跟随） */
  list(path: string): Promise<FileEntry[]>
  /** 单个路径的信息（lstat 语义） */
  stat(path: string): Promise<SftpStatInfo>
  /** 逐级建目录（已存在且是目录则跳过；中间有同名非目录则 REMOTE_IO） */
  mkdirs(path: string): Promise<void>
  /** 上传：先写远端临时文件再 rename 落位；中断清理半成品 */
  put(source: SftpPutSource, remotePath: string, opts?: SftpTransferOptions): Promise<{ bytes: number }>
  /** 下载到本地路径；maxBytes 超限抛 FILE_TOO_LARGE */
  get(remotePath: string, localPath: string, opts?: SftpTransferOptions): Promise<{ bytes: number; size?: number }>
  /** 下载成流（HTTP 路由直接管响应） */
  downloadStream(remotePath: string, opts?: SftpTransferOptions): Promise<{ stream: Readable; size?: number }>
}

/** 一条活跃连接。 */
export interface Transport {
  /** 向设备写入（命令文本/按键） */
  write(data: string): void
  /** 调整终端尺寸（SSH 生效；Telnet 无操作） */
  resize?(cols: number, rows: number): void
  /** 关闭并等待资源释放（幂等） */
  close(): Promise<void>
  /**
   * 懒开 SFTP 子通道（仅 SSH 支持；Telnet 无此能力，实现可不提供）。
   * 返回协议无关的 SftpLike 门面（不暴露 ssh2 类型）。
   * 连接已断开时抛 DISCONNECTED；设备未开 sftp 子系统时抛 PROTO_ERROR。
   */
  getSftp?(): Promise<SftpLike>
}

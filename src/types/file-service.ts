/**
 * 模块间契约 ③：文件服务（本地读写 + 远端 SFTP / Telnet 模拟传输的统一门面）。
 *
 * 归属：本插件实现（M1 先做本地部分，M5 做远端传输）；日志管理模块复用本接口落盘 / 下载。
 * 本文件只放声明；实现在 src/file-service.ts（M1 起）。改动规则同 events.ts。
 * @module dsh-terminal-manager/types/file-service
 */

import type { Readable } from 'node:stream'

export type FileErrorCode =
  | 'VALIDATION'         // 参数不合法（空路径、非法字符等）
  | 'PATH_OUTSIDE_ROOT'  // 路径归一化 + 符号链接解析后落在树根之外
  | 'NOT_FOUND'
  | 'FILE_TOO_LARGE'     // 超过读取 / 传输上限（本地编辑 10MB；Telnet 模拟 1MB）
  | 'SESSION_NOT_FOUND'
  | 'DISCONNECTED'
  | 'REMOTE_IO'          // SFTP / 命令模拟失败
  | 'UNSUPPORTED'        // 该会话协议不支持此操作（如 Telnet 关闭了模拟传输）

/** 错误对象形状（实现类继承 Error）；message 永不含凭据 */
export interface FileServiceError extends Error {
  code: FileErrorCode
}

export interface FileEntry {
  name: string
  /** 绝对路径（本地）或远端绝对路径 */
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

/** 本地路径定位：root = 当前树根（用户在 UI 选定，前端每次调用传入）；path = 树根内的绝对路径 */
export interface LocalPathRef {
  root: string
  path: string
}

export interface ReadResult {
  content: string
  size: number
  /** 超过 maxBytes 时只返回前段并置 true（编辑器按只读打开） */
  truncated: boolean
}

export interface TransferProgress {
  op: 'upload' | 'download'
  sessionId: string
  remotePath: string
  transferred: number
  total?: number
  /** 0–100；total 未知时缺省 */
  percent?: number
}

export interface TransferResult {
  ok: true
  bytes: number
  durationMs: number
}

/** 上传的数据来源：本地树根内文件，或浏览器直传的流（远端面板「上传」按钮） */
export type UploadSource =
  | { kind: 'local'; ref: LocalPathRef }
  | { kind: 'stream'; stream: Readable; size?: number }

export interface FileService {
  // ── 本地（限当前树根内；M1 实现）──
  /** 列目录（懒加载一层） */
  listLocal(ref: LocalPathRef): Promise<FileEntry[]>
  readLocal(ref: LocalPathRef, opts?: { maxBytes?: number }): Promise<ReadResult>
  /** 原子写（先写临时文件再 rename） */
  writeLocal(ref: LocalPathRef, content: string): Promise<{ bytes: number }>
  /** 「换目录」选择器用：只列子目录，不受树根限制，只读 */
  listDirectories(absPath: string): Promise<FileEntry[]>

  // ── 远端（按会话协议分派：SSH → SFTP；Telnet → 命令模拟；M5 实现）──
  listRemote(req: { sessionId: string; path: string }): Promise<FileEntry[]>
  /** 获取远端终端当前工作目录（SFTP realpath('.')） */
  remoteCwd(req: { sessionId: string }): Promise<string>
  upload(req: { sessionId: string; remotePath: string; source: UploadSource; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult>
  /** 下载成流（HTTP 路由直接管到响应，触发浏览器保存） */
  download(req: { sessionId: string; remotePath: string; onProgress?: (p: TransferProgress) => void }): Promise<{ stream: Readable; size?: number }>
  /** 下载到本地树根内（tm_download 带 localPath 时用） */
  downloadToLocal(req: { sessionId: string; remotePath: string; target: LocalPathRef; onProgress?: (p: TransferProgress) => void }): Promise<TransferResult>
}

/** HTTP 控制面动作名（/term-manager 前缀；实现见 remotes.ts） */
export type FileRpcAction = 'files.tree' | 'files.read' | 'files.write' | 'files.dirs'

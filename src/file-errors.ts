/**
 * 文件服务错误类 —— 契约 `src/types/file-service.ts` 里 `FileServiceError` 接口的实现。
 * 单独成文件是为了让 path-security.ts 与 file-service.ts 都能用而不互相 import。
 * message 只描述问题，不含凭据。
 * @module dsh-terminal-manager/file-errors
 */

import type { FileErrorCode, FileServiceError as FileServiceErrorShape } from './types/file-service.ts'

export class FileServiceError extends Error implements FileServiceErrorShape {
  constructor(
    readonly code: FileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'FileServiceError'
  }
}

/** 把 Node 的文件系统错误映射成统一错误码。 */
export function mapFsError(error: unknown, what: string): FileServiceError {
  if (error instanceof FileServiceError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileServiceError('NOT_FOUND', `${what}不存在`, { cause: error })
  if (code === 'EACCES' || code === 'EPERM') return new FileServiceError('VALIDATION', `${what}没有访问权限`, { cause: error })
  if (code === 'EISDIR') return new FileServiceError('VALIDATION', `${what}是目录不是文件`, { cause: error })
  const message = error instanceof Error ? error.message : String(error)
  return new FileServiceError('REMOTE_IO', `${what}读写失败: ${message}`, { cause: error })
}

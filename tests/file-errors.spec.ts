import { describe, expect, it } from 'vitest'
import { FileServiceError, mapFsError } from '../src/file-errors.ts'

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`sys ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('文件错误映射', () => {
  it('ENOENT / ENOTDIR → NOT_FOUND；EACCES / EPERM → VALIDATION；EISDIR → VALIDATION', () => {
    expect(mapFsError(errno('ENOENT'), '文件')).toMatchObject({ code: 'NOT_FOUND', message: '文件不存在' })
    expect(mapFsError(errno('ENOTDIR'), '目录')).toMatchObject({ code: 'NOT_FOUND', message: '目录不存在' })
    expect(mapFsError(errno('EACCES'), '文件').code).toBe('VALIDATION')
    expect(mapFsError(errno('EPERM'), '文件').message).toBe('文件没有访问权限')
    expect(mapFsError(errno('EISDIR'), '路径').message).toBe('路径是目录不是文件')
  })
  it('其他错误 → REMOTE_IO 并带原消息；非 Error 也能包；FileServiceError 原样透传', () => {
    const io = mapFsError(errno('EBUSY'), '文件')
    expect(io.code).toBe('REMOTE_IO')
    expect(io.message).toContain('sys EBUSY')
    expect(io.cause).toBeInstanceOf(Error)
    expect(mapFsError('oops', '文件')).toMatchObject({ code: 'REMOTE_IO', message: '文件读写失败: oops' })
    expect(mapFsError(undefined, '文件').code).toBe('REMOTE_IO')
    const own = new FileServiceError('PATH_OUTSIDE_ROOT', 'x')
    expect(mapFsError(own, '文件')).toBe(own)
    expect(own.name).toBe('FileServiceError')
  })
})

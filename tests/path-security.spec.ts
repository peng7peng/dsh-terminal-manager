/**
 * B10 路径安全：逃逸用例必须全部被拒（先红后绿）。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileServiceError } from '../src/file-errors.ts'
import { isWithin, requireAbsolute, resolveInsideRoot, resolveWritePathInsideRoot } from '../src/path-security.ts'

let root: string
let outside: string
let linkToOutside: string | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-ps-root-'))
  outside = await mkdtemp(join(tmpdir(), 'tm-ps-outside-'))
  await mkdir(join(root, 'a'))
  await writeFile(join(root, 'a', 'b.txt'), 'hello')
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  // 目录链接：Windows 上 junction 不需要管理员权限；创建失败则跳过相关用例
  try {
    linkToOutside = join(root, 'escape')
    await symlink(outside, linkToOutside, 'junction')
  } catch {
    linkToOutside = undefined
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'OK'
  } catch (error) {
    return error instanceof FileServiceError ? error.code : `OTHER:${String(error)}`
  }
}

describe('isWithin（纯函数）', () => {
  it('posix：大小写敏感、含 base 本身、前缀不能是半个目录名', () => {
    expect(isWithin('/r', '/r', 'linux')).toBe(true)
    expect(isWithin('/r', '/r/x', 'linux')).toBe(true)
    expect(isWithin('/r', '/rx', 'linux')).toBe(false)
    expect(isWithin('/r', '/R/x', 'linux')).toBe(false)
    expect(isWithin('/r/', '/r/x/', 'linux')).toBe(true)
  })
  it('win32：大小写不敏感、正反斜杠混用', () => {
    expect(isWithin('C:\\Root', 'c:/root/x', 'win32')).toBe(true)
    expect(isWithin('C:\\Root', 'C:\\Rootx', 'win32')).toBe(false)
    expect(isWithin('C:\\Root', 'D:\\Root\\x', 'win32')).toBe(false)
  })
})

describe('requireAbsolute（纯函数）', () => {
  it('空 / 空白 / 含 \\0 / 相对路径 → VALIDATION', () => {
    for (const bad of ['', '   ', 'a\0b', 'relative/x.txt', './x']) {
      expect(() => requireAbsolute(bad)).toThrow(FileServiceError)
      try { requireAbsolute(bad) } catch (e) { expect((e as FileServiceError).code).toBe('VALIDATION') }
    }
  })
  it('绝对路径归一化后返回', () => {
    expect(requireAbsolute(join(root, 'a', '..', 'a', 'b.txt'))).toBe(resolve(root, 'a', 'b.txt'))
  })
})

describe('resolveInsideRoot（读围栏）', () => {
  it('根内文件 → 返回真实路径', async () => {
    const p = await resolveInsideRoot(root, join(root, 'a', 'b.txt'))
    expect(isWithin(root, p)).toBe(true)
  })
  it('根本身 → 允许', async () => {
    expect(await codeOf(resolveInsideRoot(root, root))).toBe('OK')
  })
  it('`..` 逃到根外 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(resolveInsideRoot(root, join(root, '..', 'x')))).not.toBe('OK')
    expect(await codeOf(resolveInsideRoot(root, join(root, 'a', '..', '..', outside.split(/[\\/]/).pop()!, 'secret.txt')))).toBe('PATH_OUTSIDE_ROOT')
  })
  it('根外绝对路径 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(resolveInsideRoot(root, join(outside, 'secret.txt')))).toBe('PATH_OUTSIDE_ROOT')
  })
  it('根内的目录链接指向根外 → PATH_OUTSIDE_ROOT（穿透后校验）', async ({ skip }) => {
    if (linkToOutside === undefined) skip()
    expect(await codeOf(resolveInsideRoot(root, join(linkToOutside!, 'secret.txt')))).toBe('PATH_OUTSIDE_ROOT')
  })
  it('不存在 → NOT_FOUND', async () => {
    expect(await codeOf(resolveInsideRoot(root, join(root, 'a', 'nope.txt')))).toBe('NOT_FOUND')
  })
  it('相对路径 → VALIDATION', async () => {
    expect(await codeOf(resolveInsideRoot(root, 'a/b.txt'))).toBe('VALIDATION')
  })
})

describe('resolveWritePathInsideRoot（写围栏）', () => {
  it('已存在的文件 → missing 为空', async () => {
    const r = await resolveWritePathInsideRoot(root, join(root, 'a', 'b.txt'))
    expect(r.missingSegments).toEqual([])
  })
  it('父目录存在、文件不存在 → missing 只有文件名，path 落在根内', async () => {
    const r = await resolveWritePathInsideRoot(root, join(root, 'a', 'new.txt'))
    expect(r.missingSegments).toEqual(['new.txt'])
    expect(isWithin(root, r.path)).toBe(true)
    expect(r.path.endsWith('new.txt')).toBe(true)
  })
  it('多级不存在 → missing 多段（由调用方决定是否允许）', async () => {
    const r = await resolveWritePathInsideRoot(root, join(root, 'a', 'no', 'dir', 'x.txt'))
    expect(r.missingSegments).toEqual(['no', 'dir', 'x.txt'])
  })
  it('目标在根外（即使尚不存在）→ PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(resolveWritePathInsideRoot(root, join(outside, 'new.txt')))).toBe('PATH_OUTSIDE_ROOT')
  })
  it('经根内链接写到根外 → PATH_OUTSIDE_ROOT', async ({ skip }) => {
    if (linkToOutside === undefined) skip()
    expect(await codeOf(resolveWritePathInsideRoot(root, join(linkToOutside!, 'new.txt')))).toBe('PATH_OUTSIDE_ROOT')
  })
})

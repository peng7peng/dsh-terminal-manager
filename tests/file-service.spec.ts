/**
 * B10 文件服务本地四件套：在临时目录里跑，不碰用户文件。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileServiceError } from '../src/file-errors.ts'
import { LocalFileService } from '../src/file-service.ts'

let root: string
let outside: string
const svc = new LocalFileService()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-fs-root-'))
  outside = await mkdtemp(join(tmpdir(), 'tm-fs-outside-'))
  await mkdir(join(root, 'zdir'))
  await mkdir(join(root, 'Adir'))
  await writeFile(join(root, 'b.txt'), 'hello world')
  await writeFile(join(root, 'a.md'), '# t')
  await writeFile(join(root, 'zdir', 'inner.py'), 'print(1)')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK' } catch (e) { return e instanceof FileServiceError ? e.code : `OTHER:${String(e)}` }
}

describe('listLocal', () => {
  it('目录在前、名字不分大小写排序、文件带 size', async () => {
    const entries = await svc.listLocal({ root, path: root })
    expect(entries.map(e => e.name)).toEqual(['Adir', 'zdir', 'a.md', 'b.txt'])
    expect(entries.map(e => e.kind)).toEqual(['dir', 'dir', 'file', 'file'])
    expect(entries[3]?.size).toBe(11)
    expect(entries[3]?.mtimeMs).toBeTypeOf('number')
  })
  it('子目录', async () => {
    const entries = await svc.listLocal({ root, path: join(root, 'zdir') })
    expect(entries.map(e => e.name)).toEqual(['inner.py'])
  })
  it('根外 → PATH_OUTSIDE_ROOT；不存在 → NOT_FOUND', async () => {
    expect(await codeOf(svc.listLocal({ root, path: outside }))).toBe('PATH_OUTSIDE_ROOT')
    expect(await codeOf(svc.listLocal({ root, path: join(root, 'nope') }))).toBe('NOT_FOUND')
  })
})

describe('readLocal', () => {
  it('读全文', async () => {
    const r = await svc.readLocal({ root, path: join(root, 'b.txt') })
    expect(r).toEqual({ content: 'hello world', size: 11, truncated: false })
  })
  it('超过 maxBytes 只读前段并标 truncated', async () => {
    const r = await svc.readLocal({ root, path: join(root, 'b.txt') }, { maxBytes: 5 })
    expect(r).toEqual({ content: 'hello', size: 11, truncated: true })
  })
  it('目录 → VALIDATION；根外 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(svc.readLocal({ root, path: join(root, 'zdir') }))).toBe('VALIDATION')
    expect(await codeOf(svc.readLocal({ root, path: join(outside, 'x') }))).toBe('PATH_OUTSIDE_ROOT')
  })
})

describe('writeLocal', () => {
  it('新建文件 → 内容正确、返回字节数、不留临时文件', async () => {
    const r = await svc.writeLocal({ root, path: join(root, 'new.txt') }, '你好')
    expect(r.bytes).toBe(6)
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('你好')
    expect((await readdir(root)).filter(n => n.includes('.tm-tmp-'))).toEqual([])
  })
  it('覆盖已有文件', async () => {
    await svc.writeLocal({ root, path: join(root, 'new.txt') }, 'v2')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('v2')
  })
  it('父目录不存在 → NOT_FOUND（不自动建目录）', async () => {
    expect(await codeOf(svc.writeLocal({ root, path: join(root, 'no', 'x.txt') }, 'x'))).toBe('NOT_FOUND')
  })
  it('目标是目录 → VALIDATION；根外 → PATH_OUTSIDE_ROOT', async () => {
    expect(await codeOf(svc.writeLocal({ root, path: join(root, 'zdir') }, 'x'))).toBe('VALIDATION')
    expect(await codeOf(svc.writeLocal({ root, path: join(outside, 'x.txt') }, 'x'))).toBe('PATH_OUTSIDE_ROOT')
  })
})

describe('listDirectories（换目录选择器）', () => {
  it('只返回子目录，不受树根限制', async () => {
    const entries = await svc.listDirectories(root)
    expect(entries.map(e => e.name)).toEqual(['Adir', 'zdir'])
    expect(entries.every(e => e.kind === 'dir')).toBe(true)
    expect((await svc.listDirectories(outside))).toEqual([])
  })
  it('相对路径 → VALIDATION；不存在 → NOT_FOUND', async () => {
    expect(await codeOf(svc.listDirectories('rel'))).toBe('VALIDATION')
    expect(await codeOf(svc.listDirectories(join(root, 'nope')))).toBe('NOT_FOUND')
  })
})

describe('远端（S5 前）', () => {
  it('四个方法都抛 UNSUPPORTED', async () => {
    expect(await codeOf(svc.listRemote({ sessionId: 's', path: '/' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.download({ sessionId: 's', remotePath: '/x' }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.downloadToLocal({ sessionId: 's', remotePath: '/x', target: { root, path: root } }))).toBe('UNSUPPORTED')
    expect(await codeOf(svc.upload({ sessionId: 's', remotePath: '/x', source: { kind: 'local', ref: { root, path: root } } }))).toBe('UNSUPPORTED')
  })
})

describe('边界：中文文件名 / 并发写 / symlink 不跟随', () => {
  it('中文文件名读写往返', async () => {
    const p = join(root, '测试文件.txt')
    const r = await svc.writeLocal({ root, path: p }, '中文内容你好')
    expect(r.bytes).toBe(Buffer.byteLength('中文内容你好', 'utf8'))
    const read = await svc.readLocal({ root, path: p })
    expect(read.content).toBe('中文内容你好')
    expect(read.truncated).toBe(false)
    // listLocal 也能列出中文文件名
    const entries = await svc.listLocal({ root, path: root })
    expect(entries.some(e => e.name === '测试文件.txt')).toBe(true)
  })

  it('并发写同一文件：最终内容是其中一次，无临时文件残留', async () => {
    const p = join(root, 'concurrent.txt')
    await Promise.all([
      svc.writeLocal({ root, path: p }, 'version-a'),
      svc.writeLocal({ root, path: p }, 'version-b'),
    ])
    const final = await readFile(p, 'utf8')
    expect(['version-a', 'version-b']).toContain(final)
    // 不留临时文件
    const files = await readdir(root)
    expect(files.filter(n => n.includes('.tm-tmp-'))).toEqual([])
  })

  it('listLocal：symlink 标 symlink 不跟随（指向目录也不递归）', async ({ skip }) => {
    const linkPath = join(root, 'a-link')
    try {
      await symlink(join(root, 'zdir'), linkPath, 'junction')
    } catch {
      skip() // Windows 无权限建 junction 时跳过
    }
    const entries = await svc.listLocal({ root, path: root })
    const link = entries.find(e => e.name === 'a-link')
    expect(link).toBeDefined()
    expect(link?.kind).toBe('symlink')
    // 不带 size / mtimeMs（没 stat 跟随）
    expect(link?.size).toBeUndefined()
  })
})

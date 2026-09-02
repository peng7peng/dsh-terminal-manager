/**
 * B10 路径安全 —— 所有本地文件操作前的围栏：归一化 → 解析符号链接 → 校验在树根内。
 *
 * 改编自 DSH-better-sidebar（MIT）的 src/path-security.ts + src/fs-tree.ts 的 isWithin/requireAbsolute，
 * 错误类换成本插件的 FileServiceError。
 * 规则：越界抛 PATH_OUTSIDE_ROOT；空路径 / 含 \0 / 相对路径抛 VALIDATION；不存在抛 NOT_FOUND。
 * @module dsh-terminal-manager/path-security
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { FileServiceError, mapFsError } from './file-errors.ts'

/** 纯函数：target 是否在 base 内（含 base 本身）。win32 大小写不敏感，斜杠统一。 */
export function isWithin(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/** 纯函数：基本形态校验，返回归一化后的绝对路径。 */
export function requireAbsolute(path: string): string {
  if (typeof path !== 'string' || path.trim().length === 0) throw new FileServiceError('VALIDATION', '路径为空')
  if (path.includes('\0')) throw new FileServiceError('VALIDATION', '路径含非法字符')
  if (!isAbsolute(path)) throw new FileServiceError('VALIDATION', '路径必须是绝对路径')
  return resolve(path)
}

async function realpathOf(path: string, what: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw mapFsError(error, what)
  }
}

/**
 * 读操作围栏：target 必须已存在。解析 root 与 target 的真实路径（穿透符号链接）后校验包含关系。
 * @returns target 的真实绝对路径（后续 fs 操作用它，不用用户传的原串）
 */
export async function resolveInsideRoot(root: string, target: string): Promise<string> {
  const absolute = requireAbsolute(target)
  const realRoot = await realpathOf(requireAbsolute(root), '树根目录')
  let realTarget: string
  try {
    realTarget = await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFsError(error, '路径')
    // 不存在：先按最近的已存在祖先判断是否越界——根外的路径一律报 PATH_OUTSIDE_ROOT，
    // 不用 NOT_FOUND 泄露「根外某文件存不存在」
    await resolveWritePathInsideRoot(root, target)
    throw new FileServiceError('NOT_FOUND', '路径不存在')
  }
  if (!isWithin(realRoot, realTarget)) throw new FileServiceError('PATH_OUTSIDE_ROOT', '路径在当前文件树根之外')
  return realTarget
}

export interface WritePathResolution {
  /** 由「最近的已存在祖先的真实路径」+ 缺失段重建的路径（祖先若是符号链接已被穿透） */
  path: string
  /** target 中尚不存在的尾段（[] = target 已存在；['x.txt'] = 只差文件本身） */
  missingSegments: string[]
}

/**
 * 写操作围栏：target 可以尚不存在。沿父目录向上找到第一个存在的祖先，解析其真实路径并校验在树根内，
 * 再把缺失段拼回去。这样路径里已存在的符号链接一定被穿透，写入不会落到根外。
 */
export async function resolveWritePathInsideRoot(root: string, target: string): Promise<WritePathResolution> {
  const absolute = requireAbsolute(target)
  const realRoot = await realpathOf(requireAbsolute(root), '树根目录')
  let existing = absolute
  const missingSegments: string[] = []
  for (;;) {
    try {
      const real = await realpath(existing)
      if (!isWithin(realRoot, real)) throw new FileServiceError('PATH_OUTSIDE_ROOT', '路径在当前文件树根之外')
      return { path: missingSegments.reduce((acc, seg) => join(acc, seg), real), missingSegments }
    } catch (error) {
      if (error instanceof FileServiceError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFsError(error, '路径')
      const parent = dirname(existing)
      if (parent === existing) throw new FileServiceError('NOT_FOUND', '路径的任何祖先目录都不存在')
      missingSegments.unshift(basename(existing))
      existing = parent
    }
  }
}

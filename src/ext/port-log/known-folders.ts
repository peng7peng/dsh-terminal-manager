/**
 * 「浏览」目录选择器用的本机目录概览：
 * - 快速访问：桌面 / 下载 / 文档 / 图片 / 音乐 / 视频（带 OneDrive 重定向回退，目录不存在则去掉）；
 * - 此电脑：Windows 枚举磁盘盘符；POSIX 只给根目录 /。
 * 平台相关的探测集中在这里，方便测试注入假平台 / 假 home。
 * @module dsh-terminal-manager/ext/port-log/known-folders
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface QuickFolder {
  id: 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos'
  label: string
  path: string
}

export interface DriveEntry {
  /** 展示名：Windows 为 `C:`，POSIX 为 `/` */
  label: string
  path: string
}

export interface KnownFolders {
  /** 用户主目录（"此电脑"表意根） */
  home: string
  quick: QuickFolder[]
  drives: DriveEntry[]
}

const QUICK_DEFS: Array<{ id: QuickFolder['id']; label: string; dirs: string[] }> = [
  { id: 'desktop', label: '桌面', dirs: ['Desktop', 'OneDrive/Desktop'] },
  { id: 'downloads', label: '下载', dirs: ['Downloads'] },
  { id: 'documents', label: '文档', dirs: ['Documents', 'OneDrive/Documents'] },
  { id: 'pictures', label: '图片', dirs: ['Pictures', 'OneDrive/Pictures'] },
  { id: 'music', label: '音乐', dirs: ['Music'] },
  { id: 'videos', label: '视频', dirs: ['Videos'] },
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveQuickFolders(home: string): Promise<QuickFolder[]> {
  const result: QuickFolder[] = []
  for (const def of QUICK_DEFS) {
    for (const rel of def.dirs) {
      const path = join(home, rel)
      if (await exists(path)) {
        result.push({ id: def.id, label: def.label, path })
        break
      }
    }
  }
  return result
}

async function resolveDrives(platform: NodeJS.Platform): Promise<DriveEntry[]> {
  if (platform === 'win32') {
    const drives: DriveEntry[] = []
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      if (await exists(`${letter}:/`)) drives.push({ label: `${letter}:`, path: `${letter}:/` })
    }
    return drives
  }
  return [{ label: '/', path: '/' }]
}

export interface KnownFoldersOptions {
  platform?: NodeJS.Platform
  home?: string
}

/** 只扫描实际存在的目录；任何盘符 / 目录都扫不到时返回空数组。 */
export async function resolveKnownFolders(options: KnownFoldersOptions = {}): Promise<KnownFolders> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const [quick, drives] = await Promise.all([resolveQuickFolders(home), resolveDrives(platform)])
  return { home, quick, drives }
}

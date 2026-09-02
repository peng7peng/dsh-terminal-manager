/**
 * 用系统默认程序打开本机文件（Excel / Word / PDF 等不在编辑器里打开的类型）。
 * 只负责「调起」，路径合法性由调用方（remotes 的 files.open）先经路径围栏校验。
 * @module dsh-terminal-manager/open-external
 */

import { spawn } from 'node:child_process'

export type SpawnFn = (cmd: string, args: string[]) => Promise<void>

/** 缺省实现：起一个分离的子进程，不等待程序退出。 */
export const defaultSpawn: SpawnFn = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', reject)
  child.once('spawn', () => { child.unref(); resolve() })
})

/** 按平台选命令。Windows 用 `cmd /c start "" <path>`（空字符串是 start 的窗口标题参数，否则带空格的路径会被当标题）。 */
export function openCommandFor(platform: NodeJS.Platform, path: string): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', path] }
  if (platform === 'darwin') return { cmd: 'open', args: [path] }
  return { cmd: 'xdg-open', args: [path] }
}

/** 调起系统默认程序打开 path。 */
export async function openWithSystem(path: string, spawnFn: SpawnFn = defaultSpawn, platform: NodeJS.Platform = process.platform): Promise<void> {
  const { cmd, args } = openCommandFor(platform, path)
  await spawnFn(cmd, args)
}

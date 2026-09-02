/**
 * 样式入口 —— 每个功能一个文件，这里拼接成一段注入 <style data-plugin="term-manager">。
 * 两人并行开发各改各的文件，避免在同一个大字符串上冲突。
 * 约定：全局类名 .tm- 前缀；用 DSH --dsw-* token；不用 CSS Modules。
 * @module dsh-terminal-manager/client/styles
 */

import { COMMON_CSS } from './common.ts'
import { FILES_CSS } from './files.ts'
import { WORKSPACE_CSS } from './workspace.ts'

/** 扩展模块样式（日志管理 / 共享端口）：在此追加自己的文件导出 */
const EXT_CSS: readonly string[] = []

export const PLUGIN_CSS = [WORKSPACE_CSS, COMMON_CSS, FILES_CSS, ...EXT_CSS].join('\n')

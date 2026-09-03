/**
 * 扩展模块挂载点（浏览器半）—— 与 src/ext/index.ts 对应。
 *
 * 约定：扩展模块的 UI 放 `client/ext/<模块名>/`，样式放 `client/styles/<模块名>.ts` 并在
 * `client/styles/index.ts` 拼接；主线只在本文件加一行调用。
 * @module dsh-terminal-manager/client/ext
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { registerPortLogClient } from './port-log/index.tsx'

/** 挂载全部扩展模块的浏览器半。当前为空壳。 */
export function registerClientExtensions(ctx: ClientContext): void {
  registerPortLogClient(ctx)
  // 日志管理（扩展模块负责人）：registerLogPanel(ctx)
}

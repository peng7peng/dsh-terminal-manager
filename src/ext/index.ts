/**
 * 扩展模块挂载点（host 半）—— 日志管理 / 共享端口等模块的唯一接入口。
 *
 * 约定（两人分支并行）：
 * - 扩展模块的代码放 `src/ext/<模块名>/`，测试放 `tests/ext-<模块名>.spec.ts`；主线只在本文件加一行调用。
 * - 扩展模块只依赖 `src/types/` 里的契约（SessionManagerApi / TmEventBus / FileService），不 import 主线实现文件。
 * - 需要新契约或改契约：单独提 PR 到 main 改 `src/types/`，两人 review。
 * @module dsh-terminal-manager/ext
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TmEventBus } from '../types/events.ts'
import type { FileService } from '../types/file-service.ts'
import type { SessionManagerApi } from '../types/session-api.ts'
import { registerPortLogExtension } from './port-log/index.ts'

/** AI 工具层可用的 port-log 能力（结构化接口，避免工具层 import 扩展内部实现）。 */
export interface PortLogToolApi {
  ready: Promise<void>
  mappings: {
    list(): unknown[]
    create(input: Record<string, unknown>): Promise<unknown>
    update(id: string, patch: Record<string, unknown>): Promise<unknown>
    remove(id: string): Promise<void>
    start(id: string): Promise<unknown>
    stop(id: string): Promise<unknown>
    importCsv(csv: string): Promise<unknown>
    exportCsv(): string
  }
  shares: {
    list(): unknown[]
    start(input: Record<string, unknown>): Promise<unknown>
    stop(sessionId: string): Promise<void>
  }
  sessionLogs: {
    list(): unknown[]
    start(sessionId: string, options: { timestamp?: boolean; stripAnsi?: boolean }, directory?: string): Promise<unknown>
    update(sessionId: string, options: { timestamp?: boolean; stripAnsi?: boolean }): Promise<unknown>
    stop(sessionId: string): Promise<void>
    getDefaultDirectory(): string
    listDir(rawPath?: string): Promise<{ path: string; parent: string | null; dirs: string[] }>
    knownFolders(): Promise<unknown>
  }
}

/** 扩展模块挂载后返回给主线的能力句柄。 */
export interface ExtensionHandle {
  portLog?: PortLogToolApi
}

export interface ExtensionDeps {
  sessions: SessionManagerApi
  events: TmEventBus
  /** M1 起提供；之前为 undefined */
  files?: FileService
  /** 本插件落盘目录（~/.dsh/terminal-manager），扩展模块在其下开自己的子目录 */
  dataDir: string
}

/** 挂载全部扩展模块，返回 AI 工具层可用的能力句柄。 */
export function registerExtensions(ctx: Context, deps: ExtensionDeps): ExtensionHandle {
  const portLog = registerPortLogExtension(ctx, deps)
  return { ...(portLog !== undefined ? { portLog } : {}) }
}

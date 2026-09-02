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

export interface ExtensionDeps {
  sessions: SessionManagerApi
  events: TmEventBus
  /** M1 起提供；之前为 undefined */
  files?: FileService
  /** 本插件落盘目录（~/.dsh/terminal-manager），扩展模块在其下开自己的子目录 */
  dataDir: string
}

/** 挂载全部扩展模块。当前为空壳，待日志管理 / 共享端口模块接入。 */
export function registerExtensions(_ctx: Context, _deps: ExtensionDeps): void {
  // 日志管理（扩展模块负责人）：registerLogModule(ctx, deps)
  // 共享端口（扩展模块负责人）：registerSharePort(ctx, deps)
}

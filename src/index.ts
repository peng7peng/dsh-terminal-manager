/**
 * dsh-terminal-manager host 半入口 —— 装配所有后端模块。
 *
 * 职责：创建连接存储 + 会话管理器，注册 AI 工具（B6）。
 * M3 后续：注册指令通道（B7a remotes.ts）；M4：注册数据流通道（B7b ws-io.ts）。
 * 会话归本插件统一持有（公共会话池），人与 AI 共用。
 * @module dsh-terminal-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from './connection-store.ts'
import { registerAmbiguityHandling } from './ambiguity.ts'
import { resolveConfig, type Config } from './config.ts'
import { registerExtensions } from './ext/index.ts'
import { LocalFileService } from './file-service.ts'
import { registerRemotes } from './remotes.ts'
import { SessionManager } from './session-manager.ts'
import { registerTerminalTools } from './tools.ts'
import { registerWsIo } from './ws-io.ts'

/** Cordis 插件名。 */
export const name = 'terminal-manager'

/** 需要的服务：工具 + 系统提示 + Web 服务器。 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 配置 schema（DSH 按导出名 `Config` 取；类型同名）。 */
export { Config } from './config.ts'

/** 连接清单落盘目录（环境变量可覆盖，默认 $DSH_HOME 或 ~/.dsh）。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DSH_TERMINAL_MANAGER_DATA
    ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'terminal-manager')
  return base
}

/** 挂载插件。`config` 由 DSH 按 Config schema 校验后传入；直接 apply(ctx) 时取默认值。 */
export function apply(ctx: Context, config?: Partial<Config>): void {
  const cfg = resolveConfig(config)
  const dataDir = resolveDataDir()
  const store = new ConnectionStore(join(dataDir, 'connections.json'))
  const sessions = new SessionManager(store)
  const files = new LocalFileService()

  registerTerminalTools(ctx, sessions)
  registerAmbiguityHandling(ctx, sessions)

  // 两个注册函数内部用 ctx.effect(() => webServer.register(...)) 正确挂载+清理；
  // 不能再把它们的返回值传给 ctx.effect（那会立即调用清理、删掉刚注册的路由）
  registerRemotes(ctx, { sessions, store, config: cfg, files })
  registerWsIo(ctx, sessions)

  // 扩展模块（日志管理 / 共享端口）：只拿契约里的东西，主线不知道它们的内部
  registerExtensions(ctx, { sessions, events: sessions.events, files, dataDir })

  ctx.effect(() => () => {
    void sessions.closeAll()
  }, 'terminal-manager: 卸载时关闭全部会话')
}

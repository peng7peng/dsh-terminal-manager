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
import { registerRemotes } from './remotes.ts'
import { SessionManager } from './session-manager.ts'
import { registerTerminalTools } from './tools.ts'
import { registerWsIo } from './ws-io.ts'

/** Cordis 插件名。 */
export const name = 'terminal-manager'

/** 需要的服务：工具 + 系统提示 + Web 服务器。 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 连接清单落盘目录（环境变量可覆盖，默认 $DSH_HOME 或 ~/.dsh）。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DSH_TERMINAL_MANAGER_DATA
    ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'terminal-manager')
  return base
}

/** 挂载插件。 */
export function apply(ctx: Context): void {
  const store = new ConnectionStore(join(resolveDataDir(), 'connections.json'))
  const sessions = new SessionManager(store)

  registerTerminalTools(ctx, sessions)
  registerAmbiguityHandling(ctx, sessions)

  // 两个注册函数内部用 ctx.effect(() => webServer.register(...)) 正确挂载+清理；
  // 不能再把它们的返回值传给 ctx.effect（那会立即调用清理、删掉刚注册的路由）
  registerRemotes(ctx, { sessions, store })
  registerWsIo(ctx, sessions)

  ctx.effect(() => () => {
    void sessions.closeAll()
  }, 'terminal-manager: 卸载时关闭全部会话')
}

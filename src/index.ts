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
import { registerRemotes } from './remotes.ts'
import { SessionManager } from './session-manager.ts'
import { registerTerminalTools } from './tools.ts'
import { registerWsIo } from './ws-io.ts'

/** Cordis 插件名。 */
export const name = 'terminal-manager'

/** 需要的服务：工具注册表 + 系统提示片段。 */
export const inject = ['tools', 'systemPrompt']

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

  // 指令通道：client-connection 就绪后挂载（web profile 内必就绪）
  ctx.inject(['connection'], () => {
    const dispose = registerRemotes(ctx, { sessions, store })
    ctx.effect(dispose, 'terminal-manager: remotes')
  })

  // 数据流通道：webServer 就绪后挂载 /term-io
  ctx.inject(['webServer'], () => {
    const dispose = registerWsIo(ctx, sessions)
    ctx.effect(dispose, 'terminal-manager: ws-io')
  })

  ctx.effect(() => () => {
    void sessions.closeAll()
  }, 'terminal-manager: 卸载时关闭全部会话')
}

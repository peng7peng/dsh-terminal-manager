/**
 * dsh-terminal-manager host 半。
 *
 * M0 垂直切片：仅记录加载日志，验证「外部包 host 半被 DSH 装载」这条链路。
 * 后续里程碑职责见 plan.md：
 *   M2 ConnectionStore / SessionManager / 传输层
 *   M3 tm_* 工具（ctx.tools）+ termManager remotes（ctx.typert.remotes）
 *   M4 /term-io WebSocket 数据面（ctx.webServer.registerUpgrade）
 * @module dsh-terminal-manager
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名。 */
export const name = 'terminal-manager'

/** M0 无服务依赖；后续阶段按需声明（如 tools、webServer、connection）。 */
export const inject: string[] = []

/** 挂载插件。 */
export function apply(ctx: Context): void {
  ctx.logger.info('[terminal-manager] host 半已加载（M0 垂直切片）')
}

import type { Context } from '@deepseek-ai/cordis'
import type { ExtensionDeps } from '../index.ts'

/**
 * 端口映射、会话共享与日志扩展的 host 入口。
 *
 * E0 仅建立可确定卸载的生命周期边界；后续能力都在本目录内装配。
 */
export function registerPortLogExtension(ctx: Context, deps: ExtensionDeps): void {
  void deps
  if (typeof ctx.effect !== 'function') return
  ctx.effect(
    () => () => undefined,
    'terminal-manager: port-log extension',
  )
}

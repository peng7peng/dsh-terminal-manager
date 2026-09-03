import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

function EmptyPortLogSlot(): null {
  return null
}

/**
 * 端口映射、会话共享与日志扩展的浏览器入口。
 *
 * E0 只注册不可见空壳，确保不会改变现有工作区；E7 在这里接入实际 UI。
 */
export function registerPortLogClientExtension(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'term-manager-port-log-entry' },
    EmptyPortLogSlot,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'term-manager-port-log-workspace' },
    EmptyPortLogSlot,
  ))
}

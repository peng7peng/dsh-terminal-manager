/**
 * dsh-terminal-manager 浏览器半入口 —— 往 DSH 插槽挂载终端工作区。
 *
 * 不重画 DSH 原生的侧边栏与聊天：只在 sidebar.footer.action 加一个入口按钮，
 * 在 shell.overlay 挂一个覆盖层工作区（终端 + 连接面板）。
 * 配色用 DSH 页面上的 --dsw-* token；xterm 的 CSS 内联注入。
 * @module dsh-terminal-manager/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import xtermCss from 'tm:xterm-css'
import { registerClientExtensions } from './ext/index.tsx'
import { PLUGIN_CSS } from './styles/index.ts'
import { toggleWorkspace, useWorkspaceVisible } from './store.ts'
import { setPortLogVisible } from './ext/port-log/store.ts'
import { TerminalWorkspace } from './TerminalWorkspace.tsx'

/** 客户端 Cordis DI：插槽注册表。 */
export const inject = ['slots']

/** 侧边栏入口按钮。 */
function SidebarButton(props: { wide: boolean }): React.JSX.Element {
  const active = useWorkspaceVisible()
  return (
    <button
      type="button"
      onClick={() => { if (!active) setPortLogVisible(false); toggleWorkspace() }}
      title="终端管理"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        width: '100%', height: 36, border: 'none', borderRadius: 8, cursor: 'pointer',
        background: active ? 'var(--dsw-alias-state-business-tertiary, #e4edfd)' : 'transparent',
        color: active ? 'var(--dsw-alias-state-business-primary, #4170e6)' : 'var(--dsw-alias-label-secondary, #666)',
        fontSize: 13, fontWeight: 600,
      }}
    >
      <span>🖥️</span>{props.wide ? <span>终端管理</span> : null}
    </button>
  )
}

let styleInjected = false
function ensureStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'term-manager'
  tag.textContent = xtermCss + '\n' + PLUGIN_CSS
  document.head.appendChild(tag)
  styleInjected = true
}

/** 挂载浏览器半。 */
export function apply(ctx: ClientContext): void {
  ensureStyles()

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'term-manager-entry' },
    SidebarButton,
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'term-manager-workspace' },
    TerminalWorkspace,
  ))

  // 扩展模块（日志管理 / 共享端口）的浏览器半
  registerClientExtensions(ctx)
}

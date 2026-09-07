import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { PortLogWorkspace } from './PortLogWorkspace.tsx'
import { togglePortLogVisible, usePortLogState } from './store.ts'
import { setWorkspaceVisible } from '../../store.ts'

function PortLogSidebarButton(props: { wide: boolean }): React.JSX.Element {
  const { visible } = usePortLogState()
  return <button
    type="button"
    className={`tm-ext-pl-entry ${visible ? 'is-active' : ''}`}
    onClick={() => { if (!visible) setWorkspaceVisible(false); togglePortLogVisible() }}
    title="网络"
    aria-label="网络"
  ><span aria-hidden="true">⇄</span>{props.wide ? <span>网络</span> : null}</button>
}

/**
 * 端口映射、会话共享与日志扩展的浏览器入口。
 *
 * E0 只注册不可见空壳，确保不会改变现有工作区；E7 在这里接入实际 UI。
 */
export function registerPortLogClient(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'term-manager-port-log-entry' },
    PortLogSidebarButton,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'term-manager-port-log-workspace' },
    PortLogWorkspace,
  ))
}

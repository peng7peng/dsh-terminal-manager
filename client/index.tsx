/**
 * dsh-terminal-manager 浏览器半。
 *
 * M0 垂直切片：在侧边栏底部注册一个入口按钮，点击展开「hello」面板，
 * 验证「外部包浏览器半被宿主装配并渲染」这条链路。
 * 后续里程碑（M4）替换为双页签工作区（终端页 / 连接页）。
 * @module dsh-terminal-manager/client
 */

import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** 客户端 Cordis DI：slot 注册表。 */
export const inject = ['slots']

/** M0 hello 面板：按钮 + 可展开提示。 */
function HelloPanel() {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px' }}>
      <button type="button" onClick={() => setOpen(value => !value)}>
        终端管理（M0）
      </button>
      {open
        ? (
            <div style={{ padding: '12px', border: '1px solid #8884', borderRadius: '8px', fontSize: '13px' }}>
              你好！dsh-terminal-manager 浏览器半已加载。
            </div>
          )
        : null}
    </div>
  )
}

/** 挂载浏览器半。 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'terminal-manager-hello',
  }, HelloPanel))
}

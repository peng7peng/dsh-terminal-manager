/**
 * toast 渲染容器 —— 挂在工作区里一次。
 * @module dsh-terminal-manager/client/ToastHost
 */

import { useToasts } from './toast.ts'

export function ToastHost(): React.JSX.Element | null {
  const items = useToasts()
  if (items.length === 0) return null
  return (
    <div className="tm-toasts">
      {items.map(t => <div key={t.id} className={`tm-toast ${t.kind}`}>{t.text}</div>)}
    </div>
  )
}

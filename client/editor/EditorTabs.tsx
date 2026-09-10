/**
 * F8 编辑器标签栏 —— 简化自 DSH-better-sidebar（MIT）TabBar.tsx：只留开 / 关 / 切换 / 脏点，
 * 去掉拖拽分栏与自由窗口。
 * @module dsh-terminal-manager/client/editor/EditorTabs
 */

import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditorTab } from './editorStore.ts'

export function EditorTabs(props: {
  tabs: EditorTab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="tm-feTabs">
      {props.tabs.map(t => (
        <div
          key={t.id}
          className={`tm-feTab ${t.id === props.activeId ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`}
          onClick={() => props.onActivate(t.id)}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(t.id) } }}
          title={`${t.path}${t.truncated ? '（只读）' : ''}`}
        >
          <span className="nm">{t.loading ? '⏳ ' : ''}{t.name}{t.truncated ? ' 🔒' : ''}</span>
          <span className="dot" title="未保存" />
          <button type="button" className="x" onClick={(e) => { e.stopPropagation(); props.onClose(t.id) }} title="关闭"><IconCloseFill14 /></button>
        </div>
      ))}
    </div>
  )
}

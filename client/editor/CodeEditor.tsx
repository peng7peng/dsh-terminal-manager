/**
 * F9 代码编辑器 —— 第 7 步的 textarea 占位实现；第 8 步换成 CodeMirror 6（接口不变）。
 * 对外只暴露 EditorHandle（选区 / 全文 / 光标行），供 TC 执行与发送选中使用。
 * @module dsh-terminal-manager/client/editor/CodeEditor
 */

import { forwardRef, useImperativeHandle, useRef } from 'react'

export interface EditorSelection {
  text: string
  /** 1 起 */
  fromLine: number
  toLine: number
}

export interface EditorHandle {
  /** 非空选区；无则 null */
  getSelection(): EditorSelection | null
  getText(): string
  /** 光标所在行（1 起） */
  getCursorLine(): number
  focus(): void
}

export interface CodeEditorProps {
  path: string
  value: string
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function lineOfOffset(text: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export const CodeEditor = forwardRef<EditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  useImperativeHandle(ref, () => ({
    getSelection() {
      const ta = taRef.current
      if (ta === null || ta.selectionStart === ta.selectionEnd) return null
      const text = ta.value.slice(ta.selectionStart, ta.selectionEnd)
      return { text, fromLine: lineOfOffset(ta.value, ta.selectionStart), toLine: lineOfOffset(ta.value, Math.max(ta.selectionStart, ta.selectionEnd - 1)) }
    },
    getText: () => taRef.current?.value ?? props.value,
    getCursorLine: () => { const ta = taRef.current; return ta === null ? 1 : lineOfOffset(ta.value, ta.selectionStart) },
    focus: () => taRef.current?.focus(),
  }), [props.value])

  return (
    <textarea
      ref={taRef}
      className="tm-feTextarea"
      value={props.value}
      readOnly={props.readOnly}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); props.onSave() } }}
      onContextMenu={props.onContextMenu}
    />
  )
})

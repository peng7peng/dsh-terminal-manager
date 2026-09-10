/**
 * F9 代码编辑器 —— CodeMirror 6 封装（改编自 DSH-better-sidebar（MIT）TextEditor.tsx，去掉预览 / 会话相关）。
 * 行号、历史、按扩展名着色、Ctrl/Cmd+S 保存、只读模式、主题跟随 DSH 明暗切换。
 * 对外只暴露 EditorHandle（选区 / 全文 / 光标行），供 TC 执行与发送选中使用。
 * CodeMirror 的样式由它自己注入 <style>（style-mod），不需要外部 CSS 文件。
 * @module dsh-terminal-manager/client/editor/CodeEditor
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { CmThemeCompartment, cmSurfaceTheme, isDarkTheme, subscribeTheme } from './cmTheme.ts'
import { languageForPath } from './lang.ts'

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

export const CodeEditor = forwardRef<EditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeRef = useRef<CmThemeCompartment | null>(null)
  // 键位 / 监听器读最新的回调，避免重建视图
  const latest = useRef(props)
  latest.current = props

  useImperativeHandle(ref, () => ({
    getSelection() {
      const view = viewRef.current
      if (view === null) return null
      const sel = view.state.selection.main
      if (sel.empty) return null
      const doc = view.state.doc
      return {
        text: doc.sliceString(sel.from, sel.to),
        fromLine: doc.lineAt(sel.from).number,
        toLine: doc.lineAt(Math.max(sel.from, sel.to - 1)).number,
      }
    },
    getText: () => viewRef.current?.state.doc.toString() ?? latest.current.value,
    getCursorLine: () => { const v = viewRef.current; return v === null ? 1 : v.state.doc.lineAt(v.state.selection.main.head).number },
    focus: () => viewRef.current?.focus(),
  }), [])

  // 视图随 path 建 / 销（Tab 切换时组件本身也会 key 重建）
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const themeComp = new CmThemeCompartment()
    themeRef.current = themeComp
    const language = languageForPath(props.path)
    const state = EditorState.create({
      doc: latest.current.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        EditorState.tabSize.of(4),
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(isDarkTheme()),
        ...(language !== null ? [language] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString())
        }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { latest.current.onSave(); return true } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    const unsubTheme = subscribeTheme(() => { view.dispatch({ effects: themeComp.reconfigure(isDarkTheme()) }) })
    return () => {
      unsubTheme()
      view.destroy()
      viewRef.current = null
      themeRef.current = null
    }
    // value 只作初始文档；后续内容由视图自己持有（store 里的 content 是视图的镜像）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.readOnly])

  return <div className="tm-feCm" ref={hostRef} onContextMenu={props.onContextMenu} />
})

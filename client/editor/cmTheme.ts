/**
 * F9 CodeMirror 6 主题 —— 改编自 DSH-better-sidebar（MIT）src/client/cm-themes.ts + theme.ts：
 * 编辑器表面（背景 / 光标 / 行号）走 DSH --dsw-* token；语法色用 one-dark / one-light 两套具体值，
 * 放在 Compartment 里，主题切换只 reconfigure 这一部分（文档 / 撤销历史 / 滚动位置都保留）。
 * 明暗判断与 TermView 一致：body[data-ds-dark-theme]。
 * @module dsh-terminal-manager/client/editor/cmTheme
 */

import { Compartment, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags, type Tag } from '@lezer/highlight'

/** 当前是否深色主题（与 TermView 的判据一致）。 */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** 订阅主题切换；返回取消函数。 */
export function subscribeTheme(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => mo.disconnect()
}

/** 两套主题共用的表面样式（纯 token）。 */
export const cmSurfaceTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--dsw-font-code, "JetBrains Mono", Consolas, monospace)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--dsw-alias-label-primary)', padding: '6px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-tertiary)', border: 'none', paddingLeft: '4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 12px 0 6px' },
})

function cmSurfaceTint(dark: boolean): Extension {
  return EditorView.theme({
    '.cm-selectionBackground, .cm-focused .cm-selectionBackground, ::selection': { backgroundColor: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' },
    '.cm-cursor': { borderLeftColor: dark ? '#fff' : '#000' },
  }, { dark })
}

interface HighlightRule { tag: Tag | readonly Tag[]; color?: string; fontStyle?: string; fontWeight?: string; textDecoration?: string }

/** one-dark */
const HIGHLIGHTS_DARK: HighlightRule[] = [
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.string, color: '#98c379' },
  { tag: [tags.number, tags.bool, tags.atom], color: '#d19a66' },
  { tag: [tags.typeName, tags.className], color: '#e5c07b' },
  { tag: [tags.propertyName, tags.variableName, tags.tagName], color: '#e06c75' },
  { tag: tags.function(tags.variableName), color: '#61afef' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.attributeName, color: '#d19a66' },
  { tag: tags.heading, color: '#e06c75', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.link, color: '#61afef', textDecoration: 'underline' },
  { tag: tags.meta, color: '#e5c07b' },
  { tag: tags.invalid, color: '#ffffff', fontWeight: 'bold' },
]

/** one-light */
const HIGHLIGHTS_LIGHT: HighlightRule[] = [
  { tag: tags.comment, color: '#a0a1a7', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#a626a4' },
  { tag: tags.string, color: '#50a14f' },
  { tag: tags.number, color: '#986801' },
  { tag: [tags.bool, tags.atom], color: '#0184bc' },
  { tag: [tags.typeName, tags.className], color: '#c18401' },
  { tag: [tags.propertyName, tags.variableName, tags.tagName], color: '#e45649' },
  { tag: tags.function(tags.variableName), color: '#c18401' },
  { tag: tags.operator, color: '#383a42' },
  { tag: tags.attributeName, color: '#986801' },
  { tag: tags.heading, color: '#e45649', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.link, color: '#4078f2', textDecoration: 'underline' },
  { tag: tags.meta, color: '#c18401' },
  { tag: tags.invalid, color: '#ffffff', fontWeight: 'bold' },
]

function themeExtensions(dark: boolean): Extension[] {
  return [cmSurfaceTint(dark), syntaxHighlighting(HighlightStyle.define(dark ? HIGHLIGHTS_DARK : HIGHLIGHTS_LIGHT))]
}

/** 每个编辑器一个 Compartment：主题切换时 reconfigure。 */
export class CmThemeCompartment {
  private readonly compartment = new Compartment()
  of(dark: boolean): Extension { return this.compartment.of(themeExtensions(dark)) }
  reconfigure(dark: boolean) { return this.compartment.reconfigure(themeExtensions(dark)) }
}

/**
 * F9 语法高亮：扩展名 → CodeMirror 语言。裁剪自 DSH-better-sidebar（MIT）src/client/lang.ts，
 * 只留本插件要编辑的类型：shell / python / json / markdown；其余（.txt/.csv/.ini 等）纯文本不着色。
 * 注意 `.txt` 是 TC 脚本，故意不着色（脚本语法与 shell 不同，着色反而误导）。
 * @module dsh-terminal-manager/client/editor/lang
 */

import { StreamLanguage, type LanguageSupport } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import type { Extension } from '@codemirror/state'

export type LanguageKey = 'shell' | 'python' | 'json' | 'markdown'

/** 纯函数：扩展名（小写，不含点）→ 语言键；不支持返回 null。 */
export function languageKeyForExt(ext: string): LanguageKey | null {
  switch (ext) {
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'py': case 'pyw': return 'python'
    case 'json': case 'jsonc': return 'json'
    case 'md': case 'markdown': return 'markdown'
    default: return null
  }
}

export function extOfPath(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

const FACTORIES: Record<LanguageKey, () => LanguageSupport | Extension> = {
  shell: () => StreamLanguage.define(shell),
  python: () => python(),
  json: () => json(),
  markdown: () => markdown(),
}

/** 路径对应的语言扩展；不支持返回 null。 */
export function languageForPath(path: string): Extension | null {
  const key = languageKeyForExt(extOfPath(path))
  return key === null ? null : FACTORIES[key]()
}

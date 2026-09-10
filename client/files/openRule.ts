/**
 * 双击文件时的分流规则：文本类进编辑器，其余交给系统默认程序（Excel / Word / PDF / 图片 …）。
 * @module dsh-terminal-manager/client/files/openRule
 */

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'sh', 'bash', 'zsh', 'py', 'pyw', 'json', 'jsonc', 'ini', 'cfg', 'conf', 'csv', 'tsv',
  'log', 'yaml', 'yml', 'xml', 'toml', 'bat', 'cmd', 'ps1', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css',
  'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'go', 'rs', 'sql', 'env', 'properties', 'gitignore', 'dockerfile', 'makefile',
])

export function extOfName(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? name.toLowerCase() : name.slice(i + 1).toLowerCase()
}

/** 是否在内置编辑器里打开。无扩展名的文件也当文本（README、Makefile 之类）。 */
export function isTextEditable(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i <= 0) return true
  return TEXT_EXTS.has(extOfName(name))
}

export type OpenTarget = 'editor' | 'system'

export function openTargetFor(name: string): OpenTarget {
  return isTextEditable(name) ? 'editor' : 'system'
}

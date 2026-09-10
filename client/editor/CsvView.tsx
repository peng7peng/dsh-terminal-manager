/**
 * F9 CSV 表格渲染 —— 打开 .csv/.tsv 文件时以表格形式展示，替代纯文本。
 * 解析逻辑：支持引号包裹、引号转义（""）、\r\n / \n / \r 换行；首行作表头。
 * 只读视图；点「文本」切换回 CodeMirror 编辑。
 * @module dsh-terminal-manager/client/editor/CsvView
 */

import { useMemo } from 'react'

/** 最大渲染行数，防止超大 CSV 卡死浏览器 */
const MAX_RENDER_ROWS = 5000

/**
 * 解析 CSV 文本为二维数组。支持引号包裹、引号内换行、"" 转义。
 * @param text CSV 原文
 * @param delimiter 分隔符（',' 或 '\t'）
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  // 剥掉 BOM，否则首字符非 " 导致引号包裹检测失效
  const src = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      if (row.some((v) => v.trim().length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((v) => v.trim().length > 0)) rows.push(row)
  return rows
}

export interface CsvViewProps {
  content: string
  delimiter: string
}

export function CsvView({ content, delimiter }: CsvViewProps): React.JSX.Element {
  const { headers, rows, truncated } = useMemo(() => {
    const all = parseCsv(content, delimiter)
    if (all.length === 0) return { headers: [] as string[], rows: [] as string[][], truncated: false }
    const hdr = all[0]!
    const data = all.slice(1)
    const tr = data.length > MAX_RENDER_ROWS
    return { headers: hdr, rows: tr ? data.slice(0, MAX_RENDER_ROWS) : data, truncated: tr }
  }, [content, delimiter])

  if (headers.length === 0) {
    return <div className="tm-feCsvEmpty">空文件</div>
  }

  const colCount = headers.length

  return (
    <div className="tm-feCsv">
      <div className="tm-feCsvScroll">
        <table className="tm-feCsvTable">
          <thead>
            <tr>
              <th className="tm-feCsvIdx">#</th>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                <td className="tm-feCsvIdx">{ri + 1}</td>
                {Array.from({ length: colCount }, (_, ci) => (
                  <td key={ci}>{row[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <div className="tm-feCsvTrunc">行数超过 {MAX_RENDER_ROWS}，只显示前 {MAX_RENDER_ROWS} 行。切到「文本」可查看完整内容。</div>
      )}
    </div>
  )
}

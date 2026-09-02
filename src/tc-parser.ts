/**
 * B11 TC 脚本解析 —— 纯函数，无 I/O。语法按 2026-09-02 真实样例（见 spec.md B11）：
 *
 *   ##>012        切换当前目标为窗口 0、1、2（块状态，持续到下一个 ##>）
 *   [标题] / [!标题]  大标题：不发送、不重置目标
 *   ###内容        「可发送的注释」：整行原样发送
 *   ##内容         注释：不发送
 *   #内容          小标题：不发送
 *   其他非空行     命令：发到当前目标；文件开头默认目标 [0]
 *
 * 前端把 TcLine 翻译成 { sessionId, command } 序列逐条发送；后端不知道 TC 概念。
 * @module dsh-terminal-manager/tc-parser
 */

export type TcLineKind = 'target' | 'section' | 'subtitle' | 'comment' | 'blank' | 'command'

export interface TcLine {
  /** 1 起的行号（相对传入文本；可用 lineOffset 平移） */
  lineNo: number
  kind: TcLineKind
  /** 原始行（去掉行尾 \r） */
  raw: string
  /** 该行生效的目标窗口编号（对 target 行 = 切换后的目标；其他行 = 当前目标） */
  targets: readonly number[]
  /** kind = command 时：要发送的文本（右侧去空白） */
  command?: string
  /** kind = section 时：标题文字（去掉 [ ] 与 !） */
  section?: string
}

export interface ParseOptions {
  /** 起始目标（选区执行时传 resolveTargetsAt 的结果）；缺省 [0] */
  initialTargets?: readonly number[]
  /** 行号偏移：选区从整文的第 N 行开始时传 N-1，使 lineNo 与整文一致 */
  lineOffset?: number
}

/** 缺省目标：文件开头未切换时发到窗口 0。 */
export const DEFAULT_TARGETS: readonly number[] = [0]

const TARGET_RE = /^\s*##>\s*([0-9]+)\s*$/
const SECTION_RE = /^\s*\[(!?)([^\]]*)\]\s*$/

/** 把 "012" 拆成去重、保序的 [0,1,2]。 */
export function parseTargetDigits(digits: string): number[] {
  const out: number[] = []
  for (const ch of digits) {
    const n = Number(ch)
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/** 解析脚本文本。 */
export function parseTcScript(text: string, options: ParseOptions = {}): TcLine[] {
  let targets: readonly number[] = options.initialTargets ?? DEFAULT_TARGETS
  const offset = options.lineOffset ?? 0
  const lines = text.split(/\r?\n/)
  // 末尾换行会多出一个空串行；保留它对行号无害，但没必要
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((raw, i): TcLine => {
    const lineNo = i + 1 + offset
    const targetMatch = TARGET_RE.exec(raw)
    if (targetMatch !== null) {
      targets = parseTargetDigits(targetMatch[1]!)
      return { lineNo, kind: 'target', raw, targets }
    }
    if (raw.trim().length === 0) return { lineNo, kind: 'blank', raw, targets }
    const sectionMatch = SECTION_RE.exec(raw)
    if (sectionMatch !== null) return { lineNo, kind: 'section', raw, targets, section: sectionMatch[2]!.trim() }
    const t = raw.trimStart()
    if (t.startsWith('###')) return { lineNo, kind: 'command', raw, targets, command: raw.trimEnd() }
    if (t.startsWith('##')) return { lineNo, kind: 'comment', raw, targets }
    if (t.startsWith('#')) return { lineNo, kind: 'subtitle', raw, targets }
    return { lineNo, kind: 'command', raw, targets, command: raw.trimEnd() }
  })
}

/** 某行之前（不含该行）生效的目标：最后一次 ##> 的结果；没有则缺省 [0]。 */
export function resolveTargetsAt(lines: readonly TcLine[], lineNo: number): readonly number[] {
  let result: readonly number[] = DEFAULT_TARGETS
  for (const line of lines) {
    if (line.lineNo >= lineNo) break
    if (line.kind === 'target') result = line.targets
  }
  return result
}

export interface SectionRange {
  /** 含标题行（若该位置之前没有标题则从第一行起） */
  start: number
  /** 下一个标题的前一行（含） */
  end: number
  section?: string
}

/** lineNo 所在的「节」：从上一个 [标题]（含）到下一个 [标题] 之前。 */
export function sectionRange(lines: readonly TcLine[], lineNo: number): SectionRange | undefined {
  if (lines.length === 0) return undefined
  let start = lines[0]!.lineNo
  let section: string | undefined
  let end = lines[lines.length - 1]!.lineNo
  let seen = false
  for (const line of lines) {
    if (line.kind !== 'section') continue
    if (line.lineNo <= lineNo) {
      start = line.lineNo
      section = line.section
      seen = true
    } else {
      end = line.lineNo - 1
      break
    }
  }
  if (!seen && start > lineNo) return undefined
  return section !== undefined ? { start, end, section } : { start, end }
}

/** 只取可执行的命令行（供确认框与执行器用）。 */
export function commandLines(lines: readonly TcLine[]): TcLine[] {
  return lines.filter(l => l.kind === 'command')
}

/** 找出「间隔 N 秒再发」类人读提示（暂定决策②：只提醒，不自动等待）。 */
export function delayHints(lines: readonly TcLine[]): Array<{ lineNo: number; text: string }> {
  return lines
    .filter(l => l.kind === 'comment' && /间隔\s*\d+\s*(s|秒)/i.test(l.raw))
    .map(l => ({ lineNo: l.lineNo, text: l.raw.replace(/^\s*##/, '').trim() }))
}

import { describe, expect, it } from 'vitest'
import { TerminalTextNormalizer } from '../src/ext/port-log/terminal-text-normalizer.ts'

describe('port-log 终端文本归一化', () => {
  it('跨 chunk 清理 CSI/OSC ANSI 序列', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    expect(normalizer.push('\x1b[')).toBe('')
    expect(normalizer.push('31mred\x1b]0;title')).toBe('')
    expect(normalizer.push('\x07 text\x1b[0m\n')).toBe('red text\n')
  })

  it('处理退格、CR 覆盖、CRLF 和半行 flush', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    expect(normalizer.push('abc\b!\nold text\rnew\r\nlast')).toBe('ab!\nnew text\n')
    expect(normalizer.flush()).toBe('last\n')
  })

  it('可在每个逻辑行前添加 UTC 时间戳', () => {
    const normalizer = new TerminalTextNormalizer(
      { timestamp: true, stripAnsi: true },
      () => new Date('2026-09-03T01:02:03.000Z'),
    )
    expect(normalizer.push('one\ntwo\n')).toBe('[2026-09-03T01:02:03.000Z] one\n[2026-09-03T01:02:03.000Z] two\n')
  })

  it('stripAnsi 为 false 时保留 ANSI 序列', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: false })
    const result = normalizer.push('\x1b[31mred\x1b[0m\n')
    expect(result).toContain('\x1b[31m')
    expect(result).toContain('red')
  })

  it('空输入返回空字符串', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    expect(normalizer.push('')).toBe('')
  })

  it('仅换行符的输入返回换行', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    expect(normalizer.push('\n')).toBe('\n')
  })

  it('无结尾换行的文本在 flush 时补换行', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    normalizer.push('no-newline')
    expect(normalizer.flush()).toBe('no-newline\n')
  })

  it('OSC 序列跨 chunk 被正确清理', () => {
    const normalizer = new TerminalTextNormalizer({ timestamp: false, stripAnsi: true })
    expect(normalizer.push('\x1b]0;')).toBe('')
    expect(normalizer.push('title\x07')).toBe('')
    expect(normalizer.push('after\n')).toBe('after\n')
  })

  it('timestamp 和 stripAnsi 同时启用时时间戳在清理后添加', () => {
    const normalizer = new TerminalTextNormalizer(
      { timestamp: true, stripAnsi: true },
      () => new Date('2026-09-03T01:02:03.000Z'),
    )
    const result = normalizer.push('\x1b[31mtext\x1b[0m\n')
    expect(result).toBe('[2026-09-03T01:02:03.000Z] text\n')
  })
})

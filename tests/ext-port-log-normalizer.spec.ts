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
})

import type { SessionLogOptions } from './types.ts'

type AnsiState = 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape'

export class TerminalTextNormalizer {
  private ansiState: AnsiState = 'text'
  private line: string[] = []
  private cursor = 0
  private pendingCr = false

  constructor(
    private readonly options: SessionLogOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  push(chunk: string): string {
    let output = ''
    for (const char of chunk) {
      const visible = this.options.stripAnsi ? this.filterAnsi(char) : char
      if (visible === '') continue
      for (const item of visible) output += this.consume(item)
    }
    return output
  }

  flush(): string {
    if (this.line.length === 0) return ''
    const value = this.formatLine(this.line.join(''))
    this.line = []
    this.cursor = 0
    this.pendingCr = false
    return value
  }

  private consume(char: string): string {
    if (char === '\r') {
      this.cursor = 0
      this.pendingCr = true
      return ''
    }
    if (char === '\n') {
      const output = this.formatLine(this.line.join(''))
      this.line = []
      this.cursor = 0
      this.pendingCr = false
      return output
    }
    this.pendingCr = false
    if (char === '\b') {
      if (this.cursor > 0) {
        this.cursor -= 1
        this.line.splice(this.cursor, 1)
      }
      return ''
    }
    if (this.cursor < this.line.length) this.line[this.cursor] = char
    else this.line.push(char)
    this.cursor += 1
    return ''
  }

  private formatLine(line: string): string {
    const prefix = this.options.timestamp ? `[${this.now().toISOString()}] ` : ''
    return `${prefix}${line}\n`
  }

  private filterAnsi(char: string): string {
    switch (this.ansiState) {
      case 'text':
        if (char === '\x1b') {
          this.ansiState = 'escape'
          return ''
        }
        return char
      case 'escape':
        if (char === '[') this.ansiState = 'csi'
        else if (char === ']') this.ansiState = 'osc'
        else this.ansiState = 'text'
        return ''
      case 'csi':
        if (char >= '@' && char <= '~') this.ansiState = 'text'
        return ''
      case 'osc':
        if (char === '\x07') this.ansiState = 'text'
        else if (char === '\x1b') this.ansiState = 'osc-escape'
        return ''
      case 'osc-escape':
        this.ansiState = char === '\\' ? 'text' : 'osc'
        return ''
    }
  }
}

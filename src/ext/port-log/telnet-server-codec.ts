import { StringDecoder } from 'node:string_decoder'

type State = 'data' | 'iac' | 'option' | 'subnegotiation' | 'subnegotiation-iac'

export class TelnetServerCodec {
  private state: State = 'data'
  private readonly decoder = new StringDecoder('utf8')
  private pendingCr = false

  push(chunk: Buffer): string {
    const bytes: number[] = []
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === 0xff) this.state = 'iac'
          else bytes.push(byte)
          break
        case 'iac':
          if (byte === 0xff) {
            bytes.push(byte)
            this.state = 'data'
          } else if (byte === 0xfa) {
            this.state = 'subnegotiation'
          } else if (byte >= 0xfb && byte <= 0xfe) {
            this.state = 'option'
          } else {
            this.state = 'data'
          }
          break
        case 'option':
          this.state = 'data'
          break
        case 'subnegotiation':
          if (byte === 0xff) this.state = 'subnegotiation-iac'
          break
        case 'subnegotiation-iac':
          this.state = byte === 0xf0 ? 'data' : 'subnegotiation'
          break
      }
    }
    return this.normalize(this.decoder.write(Buffer.from(bytes)))
  }

  end(): string {
    return this.normalize(this.decoder.end(), true)
  }

  private normalize(text: string, flush = false): string {
    let result = ''
    for (const char of text) {
      if (this.pendingCr) {
        result += '\r'
        this.pendingCr = false
        if (char === '\n' || char === '\0') continue
      }
      if (char === '\r') this.pendingCr = true
      else result += char
    }
    if (flush && this.pendingCr) {
      result += '\r'
      this.pendingCr = false
    }
    return result
  }
}

export function escapeTelnetOutput(data: string): Buffer {
  const parts: Buffer[] = []
  for (const char of data) {
    if (char.codePointAt(0) === 0xff) parts.push(Buffer.from([0xff, 0xff]))
    else parts.push(Buffer.from(char, 'utf8'))
  }
  return Buffer.concat(parts)
}

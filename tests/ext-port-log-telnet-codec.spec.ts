import { describe, expect, it } from 'vitest'
import { escapeTelnetOutput, TelnetServerCodec } from '../src/ext/port-log/telnet-server-codec.ts'

describe('port-log Telnet 服务端编解码', () => {
  it('跨 chunk 消费 IAC 选项和 SB/SE', () => {
    const codec = new TelnetServerCodec()
    expect(codec.push(Buffer.from([0x61, 0xff]))).toBe('a')
    expect(codec.push(Buffer.from([0xfb, 0x01, 0xff, 0xfa, 0x18]))).toBe('')
    expect(codec.push(Buffer.from([0x00, 0xff, 0xf0, 0x62]))).toBe('b')
  })

  it('处理 IAC 转义、跨 chunk UTF-8 和 CRLF/CR-NUL', () => {
    const codec = new TelnetServerCodec()
    const chinese = Buffer.from('中')
    expect(codec.push(Buffer.concat([Buffer.from([0xff, 0xff]), chinese.subarray(0, 2)]))).toBe('�')
    expect(codec.push(Buffer.concat([chinese.subarray(2), Buffer.from('\r')]))).toBe('中')
    expect(codec.push(Buffer.from('\nnext\r\0tail'))).toBe('\rnext\rtail')
  })

  it('输出中的 FF 双写且尾部 CR 可 flush', () => {
    expect(escapeTelnetOutput('ÿ')).toEqual(Buffer.from([0xff, 0xff]))
    const codec = new TelnetServerCodec()
    expect(codec.push(Buffer.from('x\r'))).toBe('x')
    expect(codec.end()).toBe('\r')
  })
})

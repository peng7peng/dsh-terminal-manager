/**
 * Telnet 协商纯逻辑单测：三档归一化、跨 chunk IAC 解析、Q-method 防环、TTYPE/NAWS/0xFF 转义。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_TYPE,
  DO,
  DONT,
  ECHO,
  IAC,
  NAWS,
  SE,
  SGA,
  SB,
  TELNET_PROBE_MS,
  TTYPE,
  TTYPE_IS,
  TTYPE_SEND,
  TelnetNegotiator,
  TelnetStreamParser,
  WILL,
  WONT,
  buildNaws,
  buildTerminalType,
  escapeIac,
  escapeUserInput,
  iacCommand,
  iacSubnegotiation,
  initialNegotiation,
  normalizeTelnetMode,
} from '../src/transport/telnet-codec.ts'

const hex = (frames: Buffer[]): string => Buffer.concat(frames).toString('hex')
const bytes = (...values: number[]): Buffer => Buffer.from(values)

function collect(chunks: Buffer[]): {
  data: number[]
  commands: Array<[number, number]>
  subs: Array<[number, number[]]>
} {
  const data: number[] = []
  const commands: Array<[number, number]> = []
  const subs: Array<[number, number[]]> = []
  const parser = new TelnetStreamParser({
    onData: (chunk) => { data.push(...chunk) },
    onCommand: (cmd, option) => { commands.push([cmd, option]) },
    onSubnegotiation: (option, payload) => { subs.push([option, [...payload]]) },
  })
  for (const chunk of chunks) parser.feed(chunk)
  return { data, commands, subs }
}

describe('Telnet 模式归一化', () => {
  it('缺省 → passive；旧值 telnet → active；新值原样', () => {
    expect(normalizeTelnetMode(undefined)).toBe('passive')
    expect(normalizeTelnetMode('')).toBe('passive')
    expect(normalizeTelnetMode('bogus')).toBe('passive')
    expect(normalizeTelnetMode('telnet')).toBe('active')
    expect(normalizeTelnetMode('active')).toBe('active')
    expect(normalizeTelnetMode('passive')).toBe('passive')
    expect(normalizeTelnetMode('raw')).toBe('raw')
  })

  it('active 探测窗口是 800ms（设计文档 2.0 §3.4）', () => {
    expect(TELNET_PROBE_MS).toBe(800)
  })

  it('初始协商：只有 active 发 1 条 DO SGA；passive/raw 不发', () => {
    expect(initialNegotiation('active').map((b) => [...b])).toEqual([[IAC, DO, SGA]])
    expect(initialNegotiation('passive')).toEqual([])
    expect(initialNegotiation('raw')).toEqual([])
  })
})

describe('Telnet 字节构造与 0xFF 转义', () => {
  it('IAC 命令 / 子协商 / TTYPE / NAWS', () => {
    expect([...iacCommand(WILL, ECHO)]).toEqual([IAC, WILL, ECHO])
    expect(hex([iacSubnegotiation(TTYPE, Buffer.from([TTYPE_IS, 0x41]))]))
      .toBe([IAC, SB, TTYPE, TTYPE_IS, 0x41, IAC, SE].map((b) => b.toString(16).padStart(2, '0')).join(''))
    const ttype = buildTerminalType()
    expect([...ttype.subarray(0, 4)]).toEqual([IAC, SB, TTYPE, TTYPE_IS])
    expect(ttype.toString('ascii')).toContain(DEFAULT_TERMINAL_TYPE)
    expect(buildTerminalType('vt100').toString('ascii')).toContain('vt100')
    // NAWS：宽高各 2 字节大端
    expect([...buildNaws(80, 24)]).toEqual([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE])
  })

  it('子协商与用户输入里的 0xFF 都双写成 IAC IAC（RFC 1073）', () => {
    expect([...escapeIac(bytes(1, 2, 3))]).toEqual([1, 2, 3])
    expect([...escapeIac(bytes(1, IAC, 2))]).toEqual([1, IAC, IAC, 2])
    expect([...escapeUserInput(bytes(IAC))]).toEqual([IAC, IAC])
    // NAWS cols=255：低字节 0xFF 必须转义，否则对端解析错位
    expect([...buildNaws(255, 41)]).toEqual([IAC, SB, NAWS, 0, IAC, IAC, 0, 41, IAC, SE])
  })
})

describe('TelnetStreamParser 跨 chunk 解析', () => {
  it('普通数据原样输出', () => {
    expect(collect([Buffer.from('hello')])).toEqual({ data: [...Buffer.from('hello')], commands: [], subs: [] })
  })

  it('命令与数据混排：按出现顺序回调，数据不会串位', () => {
    const result = collect([bytes(0x41, IAC, WILL, ECHO, 0x42)])
    expect(result.data).toEqual([0x41, 0x42])
    expect(result.commands).toEqual([[WILL, ECHO]])
  })

  it('逐字节喂入（IAC 序列跨 chunk）也能正确解析', () => {
    const stream = Buffer.concat([Buffer.from('AB'), bytes(IAC, WILL, SGA), Buffer.from('CD'), bytes(IAC, IAC)])
    const result = collect([...stream].map((b) => bytes(b)))
    expect(result.data).toEqual([0x41, 0x42, 0x43, 0x44, IAC])
    expect(result.commands).toEqual([[WILL, SGA]])
  })

  it('IAC IAC = 数据 0xFF；未知 IAC 命令忽略', () => {
    const result = collect([bytes(0x41, IAC, IAC, 0x42, IAC, 241, 0x43)])
    expect(result.data).toEqual([0x41, IAC, 0x42, 0x43])
    expect(result.commands).toEqual([])
  })

  it('子协商数据解析（含 IAC IAC 转义）', () => {
    const result = collect([bytes(IAC, SB, TTYPE, TTYPE_SEND, 0x07, IAC, IAC, 0x08, IAC, SE)])
    expect(result.subs).toEqual([[TTYPE, [TTYPE_SEND, 0x07, IAC, 0x08]]])
    expect(result.commands).toEqual([])
  })

  it('非法子协商（IAC + 非 SE/IAC）重置，不吞掉后续普通数据', () => {
    const result = collect([bytes(IAC, SB, TTYPE, 1, IAC, 5, 0x41)])
    expect(result.subs).toEqual([])
    expect(result.data).toEqual([0x41])
  })

  it('半截序列 pending=true，补齐后恢复 false', () => {
    const parser = new TelnetStreamParser({ onData: () => {}, onCommand: () => {}, onSubnegotiation: () => {} })
    parser.feed(bytes(IAC, WILL))
    expect(parser.pending).toBe(true)
    parser.feed(bytes(ECHO))
    expect(parser.pending).toBe(false)
    parser.feed(bytes(IAC, SB, TTYPE, 1))
    expect(parser.pending).toBe(true)
    parser.feed(bytes(IAC, SE))
    expect(parser.pending).toBe(false)
  })
})

describe('TelnetNegotiator Q-method', () => {
  it('DO SGA → WILL SGA；重复 DO 不再回（防 WILL/WONT 环）', () => {
    const n = new TelnetNegotiator()
    expect(n.handleCommand(DO, SGA).map((b) => [...b])).toEqual([[IAC, WILL, SGA]])
    expect(n.handleCommand(DO, SGA)).toEqual([])
    expect(n.localEnabled(SGA)).toBe(true)
    expect(n.confirmed).toBe(true)
  })

  it('DO ECHO / TTYPE / NAWS 接受；DO 未知选项 → WONT（不记 YES）', () => {
    const n = new TelnetNegotiator()
    expect(n.handleCommand(DO, ECHO).map((b) => [...b])).toEqual([[IAC, WILL, ECHO]])
    expect(n.handleCommand(DO, TTYPE).map((b) => [...b])).toEqual([[IAC, WILL, TTYPE]])
    expect(n.handleCommand(DO, NAWS).map((b) => [...b])).toEqual([[IAC, WILL, NAWS]])
    expect(n.localEnabled(NAWS)).toBe(true)
    expect(n.handleCommand(DO, 99).map((b) => [...b])).toEqual([[IAC, WONT, 99]])
    expect(n.localEnabled(99)).toBe(false)
  })

  it('DONT：本端已 YES 才回 WONT；已是 NO 静默', () => {
    const n = new TelnetNegotiator()
    n.handleCommand(DO, SGA)
    expect(n.handleCommand(DONT, SGA).map((b) => [...b])).toEqual([[IAC, WONT, SGA]])
    expect(n.handleCommand(DONT, SGA)).toEqual([])
    expect(n.localEnabled(SGA)).toBe(false)
  })

  it('WILL ECHO/SGA → DO；重复 WILL 不再回；WILL 未知 → DONT', () => {
    const n = new TelnetNegotiator()
    expect(n.handleCommand(WILL, ECHO).map((b) => [...b])).toEqual([[IAC, DO, ECHO]])
    expect(n.handleCommand(WILL, ECHO)).toEqual([])
    expect(n.handleCommand(WILL, SGA).map((b) => [...b])).toEqual([[IAC, DO, SGA]])
    expect(n.handleCommand(WILL, TTYPE).map((b) => [...b])).toEqual([[IAC, DONT, TTYPE]])
  })

  it('WONT：对端已 YES 才回 DONT；已是 NO 静默', () => {
    const n = new TelnetNegotiator()
    n.handleCommand(WILL, ECHO)
    expect(n.handleCommand(WONT, ECHO).map((b) => [...b])).toEqual([[IAC, DONT, ECHO]])
    expect(n.handleCommand(WONT, ECHO)).toEqual([])
  })

  it('TTYPE SEND → 回 xterm-256color；IS/空/未知子协商不回', () => {
    const n = new TelnetNegotiator()
    const [reply] = n.handleSubnegotiation(TTYPE, bytes(TTYPE_SEND))
    expect(reply.toString('ascii')).toContain(DEFAULT_TERMINAL_TYPE)
    expect([...reply.subarray(0, 4)]).toEqual([IAC, SB, TTYPE, TTYPE_IS])
    expect(n.handleSubnegotiation(TTYPE, bytes(TTYPE_IS, 0x41))).toEqual([])
    expect(n.handleSubnegotiation(TTYPE, Buffer.alloc(0))).toEqual([])
    expect(n.handleSubnegotiation(NAWS, bytes(0, 80, 0, 24))).toEqual([])
    expect(n.confirmed).toBe(true)
  })

  it('可自定义终端类型；markConfirmed 用作探测超时的保守判定', () => {
    const n = new TelnetNegotiator({ terminalType: 'vt100' })
    expect(n.confirmed).toBe(false)
    n.markConfirmed()
    expect(n.confirmed).toBe(true)
    const [reply] = n.handleSubnegotiation(TTYPE, bytes(TTYPE_SEND))
    expect(reply.toString('ascii')).toContain('vt100')
    expect(reply.toString('ascii')).not.toContain('xterm-256color')
  })

  it('对端请求（DO/WILL）与子协商都会标记 confirmed（真 telnetd 判据）', () => {
    const viaCommand = new TelnetNegotiator()
    viaCommand.handleCommand(WILL, ECHO)
    expect(viaCommand.confirmed).toBe(true)
    const viaSub = new TelnetNegotiator()
    viaSub.handleSubnegotiation(TTYPE, bytes(TTYPE_SEND))
    expect(viaSub.confirmed).toBe(true)
  })
})

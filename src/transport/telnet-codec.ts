/**
 * Telnet 协商纯逻辑 —— 不碰 socket，便于单测。
 *
 * 职责拆成三块：
 * - `normalizeTelnetMode`：三档模式归一化（旧值 `'telnet'` → `'active'`）。
 * - `TelnetStreamParser`：跨 chunk 的 IAC 解析状态机（数据 / 命令 / 子协商）。
 * - `TelnetNegotiator`：per-option 简化 RFC 1143 Q-method（本端 / 对端各 NO/YES 两态），
 *   支持 ECHO / SGA / TTYPE / NAWS；TTYPE 回 `xterm-256color`，NAWS 大端 2 字节 + 0xFF 转义。
 *
 * @module dsh-terminal-manager/transport/telnet-codec
 */

export type TelnetMode = 'passive' | 'active' | 'raw'

/** Telnet 协议命令字节。 */
export const IAC = 0xff
export const DONT = 0xfe
export const DO = 0xfd
export const WONT = 0xfc
export const WILL = 0xfb
export const SB = 0xfa
export const SE = 0xf0

/** Telnet 选项字节。 */
export const ECHO = 1
export const SGA = 3
export const TTYPE = 24
export const NAWS = 31

/** TTYPE 子协商动作：IS（本端发送）/ SEND（请求对端发送）。 */
export const TTYPE_IS = 0
export const TTYPE_SEND = 1

/** 默认终端类型（比传统 xterm 多 256 色，xterm.js 前端匹配）。 */
export const DEFAULT_TERMINAL_TYPE = 'xterm-256color'

/** active 模式的探测窗口：窗口内收到合法 IAC → telnetd；收到非 IAC 数据 → 裸 shell；超时 → 保守按 telnetd。 */
export const TELNET_PROBE_MS = 800

const LOCAL_OPTIONS = new Set<number>([ECHO, SGA, TTYPE, NAWS])
const REMOTE_OPTIONS = new Set<number>([ECHO, SGA])

/**
 * 三档归一化：`passive`（默认）/ `active` / `raw`。
 * 兼容旧值 `'telnet'`（等价 active）与缺省（passive）。
 */
export function normalizeTelnetMode(mode: unknown): TelnetMode {
  if (mode === 'raw') return 'raw'
  if (mode === 'active' || mode === 'telnet') return 'active'
  return 'passive'
}

/** 构建 3 字节命令（IAC + cmd + option）。 */
export function iacCommand(cmd: number, option: number): Buffer {
  return Buffer.from([IAC, cmd, option])
}

/**
 * 子协商数据里的 0xFF 转义为 IAC IAC（RFC 1073 / RFC 855）。
 * 同时用于用户输入：只有确认/激活的 telnetd 才需要把裸 0xFF 双写。
 */
export function escapeIac(data: Buffer): Buffer {
  if (!data.includes(IAC)) return data
  const out: number[] = []
  for (const byte of data) {
    out.push(byte)
    if (byte === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}

/** 用户输入 0xFF 转义（与子协商规则相同：IAC IAC）。 */
export function escapeUserInput(data: Buffer): Buffer {
  return escapeIac(data)
}

/** 构建 IAC SB option <data> IAC SE（data 里的 0xFF 自动转义）。 */
export function iacSubnegotiation(option: number, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([IAC, SB, option]),
    escapeIac(data),
    Buffer.from([IAC, SE]),
  ])
}

/** NAWS 子协商：宽度/高度各 2 字节大端（RFC 1073）。 */
export function buildNaws(cols: number, rows: number): Buffer {
  const data = Buffer.alloc(4)
  data.writeUInt16BE(cols & 0xffff, 0)
  data.writeUInt16BE(rows & 0xffff, 2)
  return iacSubnegotiation(NAWS, data)
}

/** TTYPE 子协商：IS + 终端类型。 */
export function buildTerminalType(terminalType: string = DEFAULT_TERMINAL_TYPE): Buffer {
  return iacSubnegotiation(TTYPE, Buffer.concat([Buffer.from([TTYPE_IS]), Buffer.from(terminalType, 'ascii')]))
}

/** active 模式的初始协商：1 条 DO SGA（探测用）；NAWS 等探测有结果后再发。 */
export function initialNegotiation(mode: TelnetMode): Buffer[] {
  if (mode !== 'active') return []
  return [iacCommand(DO, SGA)]
}

/** 解析器事件：数据块、命令、子协商。 */
export interface TelnetParserHandlers {
  /** 普通数据（已把 IAC IAC 还原成 0xFF） */
  onData(data: Buffer): void
  /** WILL / WONT / DO / DONT 命令 */
  onCommand(cmd: number, option: number): void
  /** IAC SB option <data> IAC SE 子协商 */
  onSubnegotiation(option: number, data: Buffer): void
}

type ParserState = 'data' | 'iac' | 'cmd' | 'sb' | 'sb-data' | 'sb-iac'

const NEGOTIATION_COMMANDS = new Set<number>([WILL, WONT, DO, DONT])

/**
 * 跨 chunk 的 IAC 解析状态机。
 * 数据按出现顺序回调：`data ` 字节先于/后于协商命令的先后关系不会被合并打乱。
 */
export class TelnetStreamParser {
  private state: ParserState = 'data'
  private command = 0
  private subOption = 0
  private subData: number[] = []

  constructor(private readonly handlers: TelnetParserHandlers) {}

  feed(chunk: Buffer): void {
    let dataStart = -1
    const flushData = (end: number): void => {
      if (dataStart >= 0 && end > dataStart) {
        this.handlers.onData(chunk.subarray(dataStart, end))
      }
      dataStart = -1
    }

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]
      switch (this.state) {
        case 'data':
          if (byte === IAC) {
            flushData(i)
            this.state = 'iac'
          } else if (dataStart < 0) {
            dataStart = i
          }
          break

        case 'iac':
          if (byte === IAC) {
            // IAC IAC = 数据字节 0xFF
            this.handlers.onData(Buffer.from([IAC]))
            this.state = 'data'
          } else if (byte === SB) {
            this.state = 'sb'
          } else if (NEGOTIATION_COMMANDS.has(byte)) {
            this.command = byte
            this.state = 'cmd'
          } else {
            // 其他 IAC 命令（NOP/GA 等）忽略
            this.state = 'data'
          }
          break

        case 'cmd':
          this.handlers.onCommand(this.command, byte)
          this.state = 'data'
          break

        case 'sb':
          this.subOption = byte
          this.subData = []
          this.state = 'sb-data'
          break

        case 'sb-data':
          if (byte === IAC) this.state = 'sb-iac'
          else this.subData.push(byte)
          break

        case 'sb-iac':
          if (byte === SE) {
            this.handlers.onSubnegotiation(this.subOption, Buffer.from(this.subData))
            this.subData = []
            this.state = 'data'
          } else if (byte === IAC) {
            // 子协商内的 IAC IAC = 数据字节 0xFF
            this.subData.push(IAC)
            this.state = 'sb-data'
          } else {
            // 非法子协商序列：按旧行为重置，丢弃半截子协商
            this.subData = []
            this.state = 'data'
          }
          break
      }
    }
    flushData(chunk.length)
  }

  /** 当前是否有跨 chunk 的半截序列（测试/诊断用）。 */
  get pending(): boolean {
    return this.state !== 'data' || this.subData.length > 0
  }
}

/** 协商器构造参数。 */
export interface TelnetNegotiatorOptions {
  /** 回给对端 TTYPE 的终端类型，默认 xterm-256color */
  terminalType?: string
}

/**
 * per-option 简化 RFC 1143 Q-method。
 *
 * 每个选项本端/对端各两态（NO/YES）：
 * - 收到 DO：本端已是 YES → 不回；否则 YES + WILL（不支持的选项回 WONT）。
 * - 收到 DONT：本端已是 NO → 不回；否则 NO + WONT。
 * - 收到 WILL：对端已是 YES → 不回；可接受则 YES + DO，否则回 DONT。
 * - 收到 WONT：对端已是 NO → 不回；否则 NO + DONT。
 *
 * 这样对端重复发同一请求时不会来回 WILL/WONT 打环（RFC 1143 的核心目的）。
 */
export class TelnetNegotiator {
  private readonly local = new Map<number, boolean>()
  private readonly remote = new Map<number, boolean>()
  private readonly terminalType: string
  private negotiationSeen = false

  constructor(options: TelnetNegotiatorOptions = {}) {
    this.terminalType = options.terminalType ?? DEFAULT_TERMINAL_TYPE
  }

  /** 是否已经见过任意合法 IAC 协商（真 telnetd 的判据）。 */
  get confirmed(): boolean {
    return this.negotiationSeen
  }

  /** 主动模式探测超时后的保守判定：按 telnetd 继续。 */
  markConfirmed(): void {
    this.negotiationSeen = true
  }

  /** 本端某选项是否已启用（如 NAWS：对端 DO 过才允许发窗口大小）。 */
  localEnabled(option: number): boolean {
    return this.local.get(option) === true
  }

  /** 处理 WILL/WONT/DO/DONT，返回要回写的字节序列。 */
  handleCommand(cmd: number, option: number): Buffer[] {
    this.negotiationSeen = true
    const responses: Buffer[] = []

    if (cmd === DO) {
      if (this.local.get(option) === true) return responses
      if (LOCAL_OPTIONS.has(option)) {
        this.local.set(option, true)
        responses.push(iacCommand(WILL, option))
      } else {
        responses.push(iacCommand(WONT, option))
      }
    } else if (cmd === DONT) {
      if (this.local.get(option) === true) {
        this.local.set(option, false)
        responses.push(iacCommand(WONT, option))
      }
    } else if (cmd === WILL) {
      if (this.remote.get(option) === true) return responses
      if (REMOTE_OPTIONS.has(option)) {
        this.remote.set(option, true)
        responses.push(iacCommand(DO, option))
      } else {
        responses.push(iacCommand(DONT, option))
      }
    } else if (cmd === WONT) {
      if (this.remote.get(option) === true) {
        this.remote.set(option, false)
        responses.push(iacCommand(DONT, option))
      }
    }
    return responses
  }

  /** 处理子协商；目前只需应答 TTYPE SEND。 */
  handleSubnegotiation(option: number, data: Buffer): Buffer[] {
    this.negotiationSeen = true
    if (option === TTYPE && data.length > 0 && data[0] === TTYPE_SEND) {
      return [buildTerminalType(this.terminalType)]
    }
    return []
  }
}

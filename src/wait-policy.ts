/**
 * B5 完成判定 —— 「命令跑完没有」的裁判。
 *
 * 纯逻辑模块（无 I/O、无定时器）：由调用方（B4 会话管理器）驱动时间，
 * 用 feed() 喂输出、用 poll() 按时间检查，便于测试。
 *
 * 三重条件，谁先满足算谁；同时满足时优先级：提示符 > 静默 > 超时。
 *   ① 静默：首个输出到达后，连续 quietMs 无新输出
 *   ② 提示符：输出末尾匹配连接级正则（可选）
 *   ③ 超时：自开始等待起超过 timeoutMs（兜底）
 * 注意：尚无输出时只有超时生效（防止慢响应设备被静默误判）。
 * @module dsh-terminal-manager/wait-policy
 */

export type WaitReason = 'quiet' | 'prompt' | 'timeout'

/** 可调参数及边界（见方案 3.4 参数表）。 */
export const WAIT_LIMITS = {
  quietMs: { min: 100, max: 5000, default: 500 },
  timeoutMs: { min: 1000, max: 300_000, default: 30_000 },
  outputCapBytes: { default: 256 * 1024 },
} as const

export interface WaitPolicyConfig {
  /** 静默期毫秒数（100–5000，默认 500） */
  quietMs?: number
  /** 提示符正则源（可选，如 `[>#\\]]\\s*$`） */
  promptPattern?: string
  /** 超时兜底毫秒数（1000–300000，默认 30000） */
  timeoutMs?: number
  /** 累计输出上限字节数（超出截断，默认 256KB） */
  outputCapBytes?: number
}

function assertRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`wait-policy: ${name} 必须在 ${min}–${max} 之间，收到 ${value}`)
  }
}

/** 一次等待的完整状态。每个 tm_send 独占一个实例。 */
export class WaitPolicy {
  private readonly quietMs: number
  private readonly timeoutMs: number
  private readonly cap: number
  private readonly prompt: RegExp | undefined
  private buffer = ''
  private isTruncated = false
  private startedAt: number | undefined
  private lastOutputAt: number | undefined

  constructor(config: WaitPolicyConfig = {}) {
    this.quietMs = config.quietMs ?? WAIT_LIMITS.quietMs.default
    this.timeoutMs = config.timeoutMs ?? WAIT_LIMITS.timeoutMs.default
    this.cap = config.outputCapBytes ?? WAIT_LIMITS.outputCapBytes.default
    assertRange(this.quietMs, WAIT_LIMITS.quietMs.min, WAIT_LIMITS.quietMs.max, 'quietMs')
    assertRange(this.timeoutMs, WAIT_LIMITS.timeoutMs.min, WAIT_LIMITS.timeoutMs.max, 'timeoutMs')
    if (config.promptPattern !== undefined) {
      try {
        this.prompt = new RegExp(config.promptPattern)
      } catch (cause) {
        throw new Error(`wait-policy: promptPattern 不是合法正则: ${String(cause)}`)
      }
    }
  }

  /** 开始计时。 */
  start(nowMs: number): void {
    this.startedAt = nowMs
  }

  /** 喂一段输出；命中提示符立即返回 'prompt'。 */
  feed(chunk: string, nowMs: number): WaitReason | undefined {
    if (chunk.length > 0) {
      this.lastOutputAt = nowMs
      this.append(chunk)
    }
    if (this.prompt !== undefined && this.prompt.test(this.buffer)) return 'prompt'
    return undefined
  }

  /** 按时间检查静默/超时；未开始返回 undefined。 */
  poll(nowMs: number): WaitReason | undefined {
    if (this.startedAt === undefined) return undefined
    if (this.lastOutputAt !== undefined && nowMs - this.lastOutputAt >= this.quietMs) return 'quiet'
    if (nowMs - this.startedAt >= this.timeoutMs) return 'timeout'
    return undefined
  }

  /** 截至目前的累计输出（可能已截断）。 */
  output(): string {
    return this.buffer
  }

  /** 是否因超过上限被截断。 */
  truncated(): boolean {
    return this.isTruncated
  }

  private append(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > this.cap) {
      this.buffer = this.buffer.slice(this.buffer.length - this.cap)
      this.isTruncated = true
    }
  }
}

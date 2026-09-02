/**
 * 模块间契约 ①：事件总线（给日志管理 / 共享端口等扩展模块订阅）。
 *
 * 规则：本目录（src/types/）只放声明，不放实现；任何改动单独提 PR 到 main，两人 review。
 * 会话管理器（B4）在输出 / 输入 / 状态变化处 emit；文件服务在传输结束处 emit。
 * 扩展模块只 on，不反向依赖终端代码。
 * @module dsh-terminal-manager/types/events
 */

import type { SessionSnapshot, SessionStatus } from './session-api.ts'

/** 输入来源：human = 人在终端里敲 / 广播栏；ai = AI 工具（过守卫）；script = 编辑器执行 TC 脚本或选中发送；broadcast = 广播接口 */
export type TmInputSource = 'human' | 'ai' | 'script' | 'broadcast'

export type TmEvent =
  /** 设备输出了一段数据（与 xterm 看到的字节一致，未做行切分） */
  | { type: 'output'; sessionId: string; data: string; ts: number }
  /** 向设备写入了一段数据（人工键入是原始按键；sendAndWait/sendImmediate 是整条命令，不含追加的换行） */
  | { type: 'input'; sessionId: string; data: string; source: TmInputSource; ts: number }
  /** 会话状态变化（connecting / open / closed / removed）；snapshot 带名称、协议、目标地址，供日志文件命名 */
  | { type: 'status'; sessionId: string; status: SessionStatus; snapshot: SessionSnapshot; ts: number }
  /** 一次文件传输结束（成功或失败）；sessionId 缺省表示纯本地操作 */
  | { type: 'file'; sessionId?: string; op: 'upload' | 'download'; path: string; ok: boolean; bytes?: number; error?: string; ts: number }

export type TmEventType = TmEvent['type']

/** 订阅过滤：不传 = 全部事件 */
export interface TmEventFilter {
  type?: TmEventType | readonly TmEventType[]
  sessionId?: string
}

export type TmEventHandler = (event: TmEvent) => void

export interface TmEventBus {
  /** 派发一个事件；订阅者抛错不影响派发方（总线内部吞掉并 console.error） */
  emit(event: TmEvent): void
  /** 订阅；返回取消订阅函数 */
  on(handler: TmEventHandler, filter?: TmEventFilter): () => void
}

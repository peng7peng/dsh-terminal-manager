/**
 * 终端操作歧义处理 —— 动态 system prompt 注入。
 *
 * 当用户的指令存在歧义（本地 vs 远程、哪台设备），注入规则让 AI 先确认再操作。
 * 每次 prompt assembly 时读取当前会话状态，生成上下文感知的指引。
 * 参考 dsh-ambiguity-handling 的纯 prompt 注入模式。
 * @module dsh-terminal-manager/ambiguity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionManager } from './session-manager.ts'

/** 注册歧义处理 system prompt 段落。 */
export function registerAmbiguityHandling(ctx: Context, sessions: SessionManager): void {
  ctx.systemPrompt.section({
    name: 'term-manager:ambiguity',
    order: 108,
    text: () => {
      const openSessions = sessions.list().filter(s => s.status === 'open')
      const sessionList = openSessions.length === 0
        ? '当前没有活跃的远程终端会话。'
        : `当前有 ${openSessions.length} 个活跃会话：\n` +
          openSessions.map(s => `- [${s.sessionId}] ${s.label} (${s.protocol} ${s.target})`).join('\n')

      return `# 终端操作歧义处理

${sessionList}

规则：
1. 用户的请求可能涉及本地文件系统或远程终端——存在歧义时必须先问用户，不要臆测、不要假设。
2. 用户明确提到某个会话的 label 或 target（如"路由器A"、"192.168.1.1"）→ 用 tm_send 直接操作该会话。
3. 用户说"所有服务器"/"每台设备"/"全部检查" → 用 tm_send_all 广播。
4. 用户说"那台服务器"但有多个活跃会话 → 列出会话选项让用户选择。
5. 不要假设用户想操作远程终端——用户可能在说本地文件系统。
6. 即使用户只有 1 个远程会话，当指令存在本地/远程歧义时，也要问。

示例：
- "看看文件夹有什么" → 问用户：看本地文件系统？还是某个远程会话？
- "在路由器A上执行 show ip route" → 直接 tm_send 到路由器A 对应的会话
- "检查所有服务器的状态" → tm_send_all 广播
- "在那台交换机上看看"（但有两台交换机）→ 列出两台让用户选`
    },
  })
}

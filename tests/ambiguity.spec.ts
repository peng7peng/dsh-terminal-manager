import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerAmbiguityHandling } from '../src/ambiguity.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'

const factory: TransportFactory = async (_t, callbacks) => ({ write: () => {}, close: async () => { callbacks.onClose('bye') } })

function fakeCtx() {
  const sections: Array<{ name: string; order: number; text: () => string }> = []
  const ctx = { systemPrompt: { section: (s: { name: string; order: number; text: () => string }) => { sections.push(s) } } } as unknown as Context
  return { ctx, sections }
}

describe('歧义处理 system prompt 段', () => {
  it('注册一段；无会话时说明「没有活跃会话」', () => {
    const { ctx, sections } = fakeCtx()
    registerAmbiguityHandling(ctx, new SessionManager(undefined, factory))
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('term-manager:ambiguity')
    const text = sections[0]!.text()
    expect(text).toContain('当前没有活跃的远程终端会话')
    expect(text).toContain('tm_send_all')
  })

  it('有会话时按 label / 协议 / 目标列出，closed 的不列', async () => {
    const { ctx, sections } = fakeCtx()
    const sm = new SessionManager(undefined, factory)
    registerAmbiguityHandling(ctx, sm)
    const a = await sm.connect({ protocol: 'telnet', host: '10.0.0.1', port: 23, label: '路由器A' })
    const b = await sm.connect({ protocol: 'ssh', host: '10.0.0.2', port: 22, label: '交换机B', username: 'u' })
    let text = sections[0]!.text()
    expect(text).toContain('当前有 2 个活跃会话')
    expect(text).toContain(`[${a.sessionId}] 路由器A (telnet 10.0.0.1:23)`)
    expect(text).toContain(`[${b.sessionId}] 交换机B (ssh 10.0.0.2:22)`)
    await sm.disconnect(b.sessionId)
    text = sections[0]!.text()
    expect(text).toContain('当前有 1 个活跃会话')
    expect(text).not.toContain('交换机B')
  })
})

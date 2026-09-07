/**
 * B7b 补充：send 抛错容错、registerWsIo 的 webServer 缺失 / loopback 栅栏 / 卸载。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerWsIo, TermIoConnection } from '../src/ws-io.ts'
import { SessionManager, type TransportFactory } from '../src/session-manager.ts'

const factory: TransportFactory = async (_t, cb) => ({ write: () => {}, close: async () => { cb.onClose('bye') } })

function fakeWs(opts: { throwOnSend?: boolean } = {}) {
  const handlers = new Map<string, (arg: unknown) => void>()
  const sent: string[] = []
  return {
    ws: {
      send: (d: string) => { if (opts.throwOnSend) throw new Error('socket closed'); sent.push(d) },
      on: (ev: string, cb: (arg: unknown) => void) => { handlers.set(ev, cb) },
      close: () => {},
    },
    sent,
    emit: (ev: string, arg: unknown) => handlers.get(ev)?.(arg),
  }
}

describe('TermIoConnection 容错', () => {
  it('ws.send 抛错时吞掉，不影响会话管理器', async () => {
    const sm = new SessionManager(undefined, factory)
    const { ws } = fakeWs({ throwOnSend: true })
    const conn = new TermIoConnection(ws, sm)
    expect(() => conn.send({ kind: 'output', sessionId: 'x', data: 'y' })).not.toThrow()
    await expect(sm.connect({ protocol: 'telnet', host: '10.0.0.1', port: 23 })).resolves.toBeTruthy()   // status 帧 send 抛错也不影响 connect
  })
  it('连接关闭后 send 直接丢弃', () => {
    const sm = new SessionManager(undefined, factory)
    const { ws, sent, emit } = fakeWs()
    const conn = new TermIoConnection(ws, sm)
    emit('close', undefined)
    conn.send({ kind: 'output', sessionId: 'x', data: 'y' })
    expect(sent).toEqual([])
  })
})

describe('registerWsIo', () => {
  it('没有 webServer → 返回空卸载函数与空广播', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const handle = registerWsIo(ctx, new SessionManager(undefined, factory))
    expect(() => handle.disposer()).not.toThrow()
    expect(() => handle.broadcastFileProgress({ kind: 'file-progress', transferId: 't', op: 'upload', sessionId: 's', remotePath: '/x', transferred: 0 })).not.toThrow()
  })

  it('注册 /term-io 升级路由；非 loopback 的 Host 直接销毁 socket；卸载调用 disposer', () => {
    let registered: { path: string; handler: (req: unknown, socket: unknown, head: Buffer) => void } | undefined
    let disposed = 0
    const ctx = {
      get: (name: string) => (name === 'webServer' ? { registerUpgrade: (r: typeof registered) => { registered = r; return () => { disposed++ } } } : undefined),
      effect: (fn: () => () => void) => fn(),
    } as unknown as Context
    const handle = registerWsIo(ctx, new SessionManager(undefined, factory))
    expect(registered?.path).toBe('/term-io')
    expect(typeof handle.broadcastFileProgress).toBe('function')
    let destroyed = 0
    registered!.handler({ headers: { host: 'evil.example:80' } }, { destroy: () => { destroyed++ } }, Buffer.alloc(0))
    expect(destroyed).toBe(1)
    handle.disposer()
    expect(disposed).toBe(1)
  })
})

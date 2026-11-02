import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConnectionStore } from '../src/connection-store.ts'
import type { ConnectionConfig } from '../src/connection-store.ts'
import { SessionManager } from '../src/session-manager.ts'
import { probeMany, probeConnection } from '../src/transport/probe.ts'
import { createDeviceLab } from './helpers.ts'

const lab = createDeviceLab()
afterAll(async () => { await lab.cleanup() })

function base(id: string, protocol: 'ssh' | 'telnet', host: string, port: number): ConnectionConfig {
  return { id, label: id, protocol, host, port, ...(protocol === 'ssh' ? { username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } } : {}) }
}

describe('连接探针', () => {
  it('Telnet：TCP 可达 → ok + latency', async () => {
    const { port } = await lab.startEchoServer()
    const result = await probeConnection(base('t1', 'telnet', '127.0.0.1', port), 2000)
    expect(result).toMatchObject({ connId: 't1', ok: true })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('Telnet：不可解析主机 → HOST_UNREACHABLE', async () => {
    const result = await probeConnection(base('t2', 'telnet', 'probe.invalid', 23), 3000)
    expect(result).toMatchObject({ ok: false, code: 'HOST_UNREACHABLE' })
  })

  it('SSH：握手 + 认证成功 → ok', async () => {
    const { port } = await lab.startSshDevice()
    const result = await probeConnection(base('s1', 'ssh', '127.0.0.1', port), 3000)
    expect(result).toMatchObject({ connId: 's1', ok: true })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('SSH：密码错误 → AUTH_FAILED，原因不含密码', async () => {
    const { port } = await lab.startSshDevice()
    const cfg = { ...base('s2', 'ssh', '127.0.0.1', port), auth: { kind: 'password' as const, password: 'wrong-pass' } }
    const result = await probeConnection(cfg, 3000)
    expect(result).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
    expect(JSON.stringify(result)).not.toContain('wrong-pass')
  })

  it('probeMany：批量返回每台结果', async () => {
    const { port } = await lab.startEchoServer()
    const results = await probeMany([base('a', 'telnet', '127.0.0.1', port), base('b', 'telnet', 'probe.invalid', 23)], 3000)
    expect(results).toHaveLength(2)
    expect(results.map(r => r.connId)).toEqual(['a', 'b'])
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
  })

  it('SessionManager.probeAll：按 store 配置探测（缺省全部）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-probe-'))
    try {
      const store = new ConnectionStore(join(dir, 'connections.json'))
      await store.load()
      const { port } = await lab.startEchoServer()
      await store.create({ label: 'p1', protocol: 'telnet', host: '127.0.0.1', port })
      const sm = new SessionManager(store)
      const results = await sm.probeAll()
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ label: 'p1', ok: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

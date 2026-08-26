import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionStore, StoreNotFoundError, StoreValidationError } from '../src/connection-store.ts'

let dir: string
let storePath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-store-'))
  storePath = join(dir, 'connections.json')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sshInput = {
  label: 'web-01',
  protocol: 'ssh' as const,
  host: '10.0.1.5',
  username: 'admin',
  auth: { kind: 'password' as const, password: 'secret-123' },
}

describe('ConnectionStore', () => {
  it('SSH + 密码：创建成功，端口默认 22', async () => {
    const store = new ConnectionStore(storePath)
    await store.load()
    const cfg = await store.create(sshInput)
    expect(cfg.id).toBeTruthy()
    expect(cfg.port).toBe(22)
    expect(store.list()).toHaveLength(1)
  })

  it('Telnet：无需认证，端口默认 23', async () => {
    const store = new ConnectionStore(storePath)
    await store.load()
    const cfg = await store.create({ label: 'sw-01', protocol: 'telnet', host: '10.0.1.8' })
    expect(cfg.port).toBe(23)
    expect(cfg.auth).toBeUndefined()
  })

  it('落盘后新实例能读回（持久化）', async () => {
    const fresh = new ConnectionStore(storePath)
    await fresh.load()
    const labels = fresh.list().map(c => c.label)
    expect(labels).toContain('web-01')
    expect(labels).toContain('sw-01')
  })

  it('SSH 缺认证 → 校验失败，且错误消息不泄露密码', async () => {
    const store = new ConnectionStore(join(dir, 'v.json'))
    await store.load()
    await expect(store.create({ label: 'x', protocol: 'ssh', host: '1.2.3.4', username: 'u' }))
      .rejects.toThrow(StoreValidationError)
    // 密码出现在任何错误消息里都是事故
    try {
      await store.create({ ...sshInput, label: '', auth: { kind: 'password', password: 'leak-check-pw' } })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain('leak-check-pw')
    }
  })

  it('必填与范围校验', async () => {
    const store = new ConnectionStore(join(dir, 'v2.json'))
    await store.load()
    await expect(store.create({ label: '', protocol: 'telnet', host: 'h' })).rejects.toThrow(/名称/)
    await expect(store.create({ label: 'a', protocol: 'telnet', host: '' })).rejects.toThrow(/IP/)
    await expect(store.create({ label: 'a', protocol: 'telnet', host: 'h', port: 70000 })).rejects.toThrow(/端口/)
    await expect(store.create({ label: 'a', protocol: 'ssh', host: 'h', username: 'u', auth: { kind: 'password', password: '' } })).rejects.toThrow(/密码/)
    await expect(store.create({ label: 'a', protocol: 'telnet', host: 'h', quietMs: 50 })).rejects.toThrow(/静默期/)
    await expect(store.create({ label: 'a', protocol: 'telnet', host: 'h', promptPattern: '[unclosed' })).rejects.toThrow(/提示符正则/)
  })

  it('更新：改标签与端口；改成不合法会被拒', async () => {
    const store = new ConnectionStore(join(dir, 'u.json'))
    await store.load()
    const cfg = await store.create({ ...sshInput })
    const updated = await store.update(cfg.id, { label: 'web-02', port: 2222 })
    expect(updated.label).toBe('web-02')
    expect(updated.port).toBe(2222)
    await expect(store.update(cfg.id, { label: '' })).rejects.toThrow(StoreValidationError)
  })

  it('删除：成功与不存在', async () => {
    const store = new ConnectionStore(join(dir, 'd.json'))
    await store.load()
    const cfg = await store.create({ label: 't', protocol: 'telnet', host: 'h' })
    await store.remove(cfg.id)
    expect(store.list()).toHaveLength(0)
    await expect(store.remove('nonexistent')).rejects.toThrow(StoreNotFoundError)
  })

  it('文件不存在时加载为空清单', async () => {
    const store = new ConnectionStore(join(dir, 'no-such-dir', 'c.json'))
    await store.load()
    expect(store.list()).toHaveLength(0)
  })
})

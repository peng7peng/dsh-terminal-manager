/**
 * SSH 半死连接兜底单测：keepalive 参数、SFTP open 超时/重试、关闭时 pending reject。
 * 用注入的假 Client，不碰真机；超时靠 TM_SFTP_OPEN_TIMEOUT_MS 缩短。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import {
  DEFAULT_KEEPALIVE_COUNT_MAX,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_SFTP_OPEN_TIMEOUT_MS,
  connectSsh,
  resolveSshSettings,
} from '../src/transport/ssh.ts'
import type { Transport } from '../src/transport/types.ts'

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly written: string[] = []
  readonly windows: Array<[number, number]> = []
  closed = false
  write(data: string): void { this.written.push(data) }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  setWindow(rows: number, cols: number): void { this.windows.push([rows, cols]) }
}

class FakeClient extends EventEmitter {
  config: Record<string, unknown> | undefined
  sftpCalls = 0
  endCalls = 0
  readonly channel = new FakeChannel()
  private sftpCallback: ((err: Error | undefined, sftp: SFTPWrapper) => void) | undefined

  connect(config: Record<string, unknown>): void {
    this.config = config
    queueMicrotask(() => this.emit('ready'))
  }

  shell(_opts: unknown, cb: (err: Error | undefined, channel: ClientChannel) => void): void {
    queueMicrotask(() => cb(undefined, this.channel as unknown as ClientChannel))
  }

  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void {
    this.sftpCalls++
    this.sftpCallback = cb
  }

  end(): void { this.endCalls++ }

  /** 模拟 ssh2 的 sftp 打开失败回调 */
  failSftp(err: Error): void { this.sftpCallback?.(err, undefined as never) }

  /** 模拟 ssh2 的 sftp 打开成功回调 */
  provideSftp(sftp: SFTPWrapper): void { this.sftpCallback?.(undefined, sftp) }
}

function fakeSftpWrapper(): { wrapper: SFTPWrapper; endCalls: () => number; emitClose: () => void } {
  let ends = 0
  const listeners = new Map<string, Array<() => void>>()
  const wrapper = {
    on(event: string, cb: () => void) {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
      return wrapper
    },
    end() { ends++ },
  } as unknown as SFTPWrapper
  return {
    wrapper,
    endCalls: () => ends,
    emitClose: () => { for (const cb of listeners.get('close') ?? []) cb() },
  }
}

async function connectWith(
  fake: FakeClient,
  env: NodeJS.ProcessEnv = {},
): Promise<Transport> {
  return connectSsh(
    { host: '127.0.0.1', port: 22, username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } },
    { onData: () => {}, onClose: () => {} },
    { cols: 80, rows: 24 },
    { createClient: () => fake as unknown as Client, env },
  )
}

describe('SSH 运行时参数（env 可覆盖）', () => {
  it('默认：SFTP open 30s、keepalive 30s × 3', () => {
    expect(resolveSshSettings({})).toEqual({
      sftpOpenTimeoutMs: 30_000,
      keepaliveIntervalMs: 30_000,
      keepaliveCountMax: 3,
    })
    expect(DEFAULT_SFTP_OPEN_TIMEOUT_MS).toBe(30_000)
    expect(DEFAULT_KEEPALIVE_INTERVAL_MS).toBe(30_000)
    expect(DEFAULT_KEEPALIVE_COUNT_MAX).toBe(3)
  })

  it('TM_SFTP_OPEN_TIMEOUT_MS / TM_SSH_KEEPALIVE_MS / TM_SSH_KEEPALIVE_COUNT 覆盖默认值', () => {
    expect(resolveSshSettings({
      TM_SFTP_OPEN_TIMEOUT_MS: '1234',
      TM_SSH_KEEPALIVE_MS: '5000',
      TM_SSH_KEEPALIVE_COUNT: '7',
    })).toEqual({ sftpOpenTimeoutMs: 1234, keepaliveIntervalMs: 5000, keepaliveCountMax: 7 })
  })

  it('非法环境变量（空/0/负数/小数/非数字）回退默认值', () => {
    const defaults = { sftpOpenTimeoutMs: 30_000, keepaliveIntervalMs: 30_000, keepaliveCountMax: 3 }
    expect(resolveSshSettings({ TM_SFTP_OPEN_TIMEOUT_MS: '', TM_SSH_KEEPALIVE_MS: '0', TM_SSH_KEEPALIVE_COUNT: '-2' })).toEqual(defaults)
    expect(resolveSshSettings({ TM_SFTP_OPEN_TIMEOUT_MS: 'abc', TM_SSH_KEEPALIVE_MS: '1.5', TM_SSH_KEEPALIVE_COUNT: 'NaN' })).toEqual(defaults)
  })

  it('keepalive 参数真正传给 ssh2 connect()', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake, { TM_SSH_KEEPALIVE_MS: '5000', TM_SSH_KEEPALIVE_COUNT: '7' })
    expect(fake.config).toMatchObject({
      host: '127.0.0.1',
      port: 22,
      username: 'admin',
      password: 'test-pass',
      readyTimeout: 15_000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 7,
    })
    await transport.close()
  })
})

describe('SSH SFTP open 超时与 pending 清理', () => {
  it('conn.sftp 不回调 → 超时 reject 明确错误；之后调用可重试而不是永久挂起', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake, { TM_SFTP_OPEN_TIMEOUT_MS: '25' })
    await expect(transport.getSftp!()).rejects.toMatchObject({ code: 'PROTO_ERROR', message: expect.stringContaining('超时') })
    expect(fake.sftpCalls).toBe(1)
    // 超时后清掉缓存的 promise：第二次会重新尝试打开
    await expect(transport.getSftp!()).rejects.toMatchObject({ code: 'PROTO_ERROR' })
    expect(fake.sftpCalls).toBe(2)
    await transport.close()
  })

  it('超时后才姗姗来迟的 sftp 子通道会被关掉，避免泄漏', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake, { TM_SFTP_OPEN_TIMEOUT_MS: '20' })
    await expect(transport.getSftp!()).rejects.toMatchObject({ code: 'PROTO_ERROR' })
    const late = fakeSftpWrapper()
    fake.provideSftp(late.wrapper)
    expect(late.endCalls()).toBe(1)
    await transport.close()
  })

  it('transport.close() 主动 reject 仍 pending 的 SFTP open（DISCONNECTED）', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake)
    const pending = transport.getSftp!()
    const expectation = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await transport.close()
    await expectation
    // 关闭后取用直接 DISCONNECTED
    await expect(transport.getSftp!()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  it('连接 close 事件也会 reject pending 的 SFTP open', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake)
    const pending = transport.getSftp!()
    const expectation = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    fake.emit('close')
    await expectation
    expect(fake.endCalls).toBe(0) // 连接层关闭不算 transport.close()
  })

  it('通道 close 同样会 reject pending 的 SFTP open', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake)
    const pending = transport.getSftp!()
    const expectation = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    fake.channel.close()
    await expectation
  })

  it('sftp 子系统打开失败 → PROTO_ERROR；失败不缓存，可重试成功并复用', async () => {
    const fake = new FakeClient()
    const transport = await connectWith(fake)
    const first = transport.getSftp!()
    const firstExpectation = expect(first).rejects.toMatchObject({ code: 'PROTO_ERROR', message: expect.stringContaining('sftp subsystem') })
    fake.failSftp(new Error('sftp subsystem disabled'))
    await firstExpectation
    expect(fake.sftpCalls).toBe(1)

    const second = transport.getSftp!()
    const wrapper = fakeSftpWrapper()
    fake.provideSftp(wrapper.wrapper)
    const facade = await second
    expect(fake.sftpCalls).toBe(2)
    // 成功结果按连接复用
    expect(await transport.getSftp!()).toBe(facade)
    // 子通道自行关闭后缓存失效，下次重开
    wrapper.emitClose()
    const third = transport.getSftp!()
    fake.provideSftp(fakeSftpWrapper().wrapper)
    await expect(third).resolves.toBeDefined()
    expect(fake.sftpCalls).toBe(3)
    await transport.close()
  })
})

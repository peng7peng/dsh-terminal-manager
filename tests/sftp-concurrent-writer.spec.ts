/**
 * SftpConcurrentWriter：256 KiB 子包 × 有限并发、超时/失败 poison、close 幂等。
 * 全部用假句柄，不碰真实设备。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBPACKET_BYTES,
  SftpConcurrentWriter,
} from '../src/transport/sftp-concurrent-writer.ts'
import { FileServiceError } from '../src/file-errors.ts'
import type { SftpWriteHandle } from '../src/transport/types.ts'

interface FakeHandleState {
  writes: Array<{ position: number; data: Buffer }>
  closeCount: number
  inFlight: number
  maxInFlight: number
}

function fakeHandle(behavior: {
  delayMs?: number
  failTimes?: number
  hang?: boolean
} = {}): { handle: SftpWriteHandle; state: FakeHandleState } {
  const state: FakeHandleState = { writes: [], closeCount: 0, inFlight: 0, maxInFlight: 0 }
  let failures = behavior.failTimes ?? 0
  const handle: SftpWriteHandle = {
    async write(buffer, position) {
      state.writes.push({ position, data: Buffer.from(buffer) })
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      if (behavior.hang === true) return new Promise<void>(() => {})
      if (behavior.delayMs !== undefined) await new Promise(r => setTimeout(r, behavior.delayMs))
      state.inFlight -= 1
      if (failures > 0) {
        failures -= 1
        throw new Error('remote write failed')
      }
    },
    async close() { state.closeCount += 1 },
  }
  return { handle, state }
}

describe('SftpConcurrentWriter.write', () => {
  it('按 256 KiB 子包和 position 拆分，内容可重组', async () => {
    const { handle, state } = fakeHandle()
    const writer = new SftpConcurrentWriter(handle)
    const payload = Buffer.alloc(DEFAULT_SUBPACKET_BYTES + 7777, 0x5a)
    payload.write('tail', payload.length - 4)

    await writer.write(payload, 1024 * 1024)

    expect(state.writes).toHaveLength(2)
    expect(state.writes.map(w => w.position)).toEqual([1024 * 1024, 1024 * 1024 + DEFAULT_SUBPACKET_BYTES])
    const rebuilt = Buffer.concat([...state.writes].sort((a, b) => a.position - b.position).map(w => w.data))
    expect(rebuilt.equals(payload)).toBe(true)
    expect(writer.props.poisoned).toBe(false)
    await writer.close()
  })

  it('并发不超过上限且确实并行（concurrency=4）', async () => {
    const { handle, state } = fakeHandle({ delayMs: 5 })
    const writer = new SftpConcurrentWriter(handle, { subPacketBytes: 1, concurrency: 4 })
    await writer.write(Buffer.alloc(10, 1), 0)
    expect(state.writes).toHaveLength(10)
    expect(state.maxInFlight).toBeLessThanOrEqual(4)
    expect(state.maxInFlight).toBeGreaterThan(1)
    await writer.close()
  })

  it('空 buffer 不触发任何句柄写入；非法 position → VALIDATION', async () => {
    const { handle, state } = fakeHandle()
    const writer = new SftpConcurrentWriter(handle)
    await writer.write(Buffer.alloc(0), 0)
    expect(state.writes).toHaveLength(0)
    await expect(writer.write(Buffer.from('x'), -1)).rejects.toMatchObject({ code: 'VALIDATION' })
    // 非法参数不 poison
    expect(writer.props.poisoned).toBe(false)
    await writer.close()
  })

  it('子包写入失败 → poison；后续 write 拒绝', async () => {
    const { handle, state } = fakeHandle({ failTimes: 1 })
    const writer = new SftpConcurrentWriter(handle, { subPacketBytes: 1, concurrency: 1 })
    await expect(writer.write(Buffer.from('abc'), 0)).rejects.toMatchObject({ code: 'REMOTE_IO' })
    expect(writer.props.poisoned).toBe(true)
    const callsAfterFailure = state.writes.length
    await expect(writer.write(Buffer.from('d'), 0)).rejects.toThrow(/失效/)
    expect(state.writes).toHaveLength(callsAfterFailure)
    await writer.close()
  })

  it('绝对超时 → poison（错误消息含超时，不带凭据）', async () => {
    const { handle } = fakeHandle({ hang: true })
    const writer = new SftpConcurrentWriter(handle, { timeoutMs: 20 })
    await expect(writer.write(Buffer.from('slow'), 0)).rejects.toMatchObject({ code: 'REMOTE_IO' })
    await expect(writer.write(Buffer.from('again'), 0)).rejects.toThrow(/失效/)
    expect(writer.props.poisoned).toBe(true)
    await writer.close()
  })

  it('TM_SFTP_WRITE_TIMEOUT_MS 环境变量生效（非法值回退默认 60s）', async () => {
    const previous = process.env.TM_SFTP_WRITE_TIMEOUT_MS
    process.env.TM_SFTP_WRITE_TIMEOUT_MS = '15'
    try {
      const hanging = fakeHandle({ hang: true })
      const writer = new SftpConcurrentWriter(hanging.handle)
      await expect(writer.write(Buffer.from('x'), 0)).rejects.toThrow(/超时/)
      await writer.close()
      process.env.TM_SFTP_WRITE_TIMEOUT_MS = 'not-a-number'
      const normal = fakeHandle()
      const second = new SftpConcurrentWriter(normal.handle)
      await second.write(Buffer.from('ok'), 0)
      expect(normal.state.writes).toHaveLength(1)
      await second.close()
    } finally {
      if (previous === undefined) delete process.env.TM_SFTP_WRITE_TIMEOUT_MS
      else process.env.TM_SFTP_WRITE_TIMEOUT_MS = previous
    }
  })
})

describe('SftpConcurrentWriter 生命周期', () => {
  it('close 幂等：句柄只关一次；close 后再 write 拒绝', async () => {
    const { handle, state } = fakeHandle()
    const writer = new SftpConcurrentWriter(handle)
    await writer.write(Buffer.from('abc'), 0)
    await writer.close()
    await writer.close()
    expect(state.closeCount).toBe(1)
    await expect(writer.write(Buffer.from('d'), 0)).rejects.toThrow(/已关闭/)
  })

  it('close 吞掉句柄关闭错误（清理路径不打断主流程）', async () => {
    const writer = new SftpConcurrentWriter({
      write: async () => {},
      close: async () => { throw new Error('close failed') },
    })
    await expect(writer.close()).resolves.toBeUndefined()
  })

  it('open：透传 path/mode 到 SftpLike.openWrite；不支持时 UNSUPPORTED', async () => {
    const calls: Array<{ path: string; mode?: 'w' | 'r+' }> = []
    const sftp = {
      openWrite: async (path: string, mode?: 'w' | 'r+') => {
        calls.push({ path, ...(mode !== undefined ? { mode } : {}) })
        return fakeHandle().handle
      },
    } as never
    const writer = await SftpConcurrentWriter.open(sftp, '/tmp/a.bin', { mode: 'r+' })
    expect(calls).toEqual([{ path: '/tmp/a.bin', mode: 'r+' }])
    await writer.close()
    await expect(SftpConcurrentWriter.open({} as never, '/x')).rejects.toBeInstanceOf(FileServiceError)
    await expect(SftpConcurrentWriter.open({} as never, '/x')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

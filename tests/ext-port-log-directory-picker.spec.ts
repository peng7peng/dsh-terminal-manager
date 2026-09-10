import { describe, expect, it, vi } from 'vitest'
import { createDirectoryPicker } from '../src/ext/port-log/directory-picker.ts'

describe('日志系统目录选择器', () => {
  it('返回包含中文和空格的原生路径，取消返回 null', async () => {
    const nativePick = vi.fn().mockResolvedValueOnce('C:\\日志 目录').mockResolvedValueOnce(null)
    const pick = createDirectoryPicker(() => ({ capability: () => ({ kind: 'native', pick: nativePick }) }))
    const signal = new AbortController().signal
    await expect(pick(signal)).resolves.toBe('C:\\日志 目录')
    await expect(pick(signal)).resolves.toBeNull()
    expect(nativePick).toHaveBeenCalledWith(signal)
  })

  it('没有原生能力时给出明确错误', async () => {
    for (const service of [undefined, { capability: () => ({ kind: 'browse' }) }]) {
      await expect(createDirectoryPicker(() => service)(new AbortController().signal)).rejects.toThrow('未启用系统目录选择器')
    }
  })

  it('拒绝重复打开，取消后释放占用，可以再次打开', async () => {
    const nativePick = vi.fn((signal: AbortSignal) => new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true })
    }))
    const pick = createDirectoryPicker(() => ({ capability: () => ({ kind: 'native', pick: nativePick }) }))
    const controller = new AbortController()
    const pending = pick(controller.signal)
    await expect(pick(new AbortController().signal)).rejects.toThrow('已打开')
    controller.abort()
    await expect(pending).resolves.toBeNull()
    nativePick.mockResolvedValueOnce(null)
    await expect(pick(new AbortController().signal)).resolves.toBeNull()
  })

  it('原生调用失败后允许重试，不泄露内部错误', async () => {
    const nativePick = vi.fn().mockRejectedValueOnce(new Error('internal detail')).mockResolvedValueOnce('/tmp/logs')
    const pick = createDirectoryPicker(() => ({ capability: () => ({ kind: 'native', pick: nativePick }) }))
    await expect(pick(new AbortController().signal)).rejects.toThrow('无法打开系统目录选择器，请重试')
    await expect(pick(new AbortController().signal)).resolves.toBe('/tmp/logs')
  })
})

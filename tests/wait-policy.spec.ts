import { describe, expect, it } from 'vitest'
import { WAIT_LIMITS, WaitPolicy } from '../src/wait-policy.ts'

describe('WaitPolicy 完成判定', () => {
  it('静默期满足 → quiet', () => {
    const wp = new WaitPolicy()
    wp.start(0)
    expect(wp.feed('hello', 100)).toBeUndefined()
    expect(wp.poll(599)).toBeUndefined()
    expect(wp.poll(600)).toBe('quiet') // 600-100 = 500ms 静默
  })

  it('尚无任何输出时，静默不生效（防慢响应误判）', () => {
    const wp = new WaitPolicy()
    wp.start(0)
    expect(wp.poll(10_000)).toBeUndefined() // 10 秒没输出也不算静默
  })

  it('无输出时由超时兜底', () => {
    const wp = new WaitPolicy()
    wp.start(0)
    expect(wp.poll(29_999)).toBeUndefined()
    expect(wp.poll(30_000)).toBe('timeout')
  })

  it('提示符命中 → 立即 prompt', () => {
    const wp = new WaitPolicy({ promptPattern: 'router>\\s*$' })
    wp.start(0)
    expect(wp.feed('partial output', 10)).toBeUndefined()
    expect(wp.feed('router> ', 20)).toBe('prompt')
  })

  it('静默与超时同时满足时，静默优先', () => {
    const wp = new WaitPolicy()
    wp.start(0)
    wp.feed('x', 10)
    expect(wp.poll(40_000)).toBe('quiet')
  })

  it('自定义静默期生效', () => {
    const wp = new WaitPolicy({ quietMs: 2000 })
    wp.start(0)
    wp.feed('x', 0)
    expect(wp.poll(1999)).toBeUndefined()
    expect(wp.poll(2000)).toBe('quiet')
  })

  it('输出超上限截断并标记', () => {
    const wp = new WaitPolicy({ outputCapBytes: 10 })
    wp.start(0)
    wp.feed('12345678901234567890', 1) // 20 字节 > 10
    expect(wp.truncated()).toBe(true)
    expect(wp.output().length).toBe(10)
    expect(wp.output()).toBe('1234567890') // 保留尾部（最新输出）
  })

  it('默认上限为 256KB', () => {
    expect(WAIT_LIMITS.outputCapBytes.default).toBe(256 * 1024)
  })

  it('越界参数直接拒绝', () => {
    expect(() => new WaitPolicy({ quietMs: 50 })).toThrow(/quietMs/)
    expect(() => new WaitPolicy({ quietMs: 6000 })).toThrow(/quietMs/)
    expect(() => new WaitPolicy({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => new WaitPolicy({ timeoutMs: 400_000 })).toThrow(/timeoutMs/)
  })

  it('非法提示符正则直接拒绝', () => {
    expect(() => new WaitPolicy({ promptPattern: '[unclosed' })).toThrow(/promptPattern/)
  })
})

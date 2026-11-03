import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger } from '../src/logger.ts'

describe('共享文件日志', () => {
  it('按级别过滤、串行写入并递归脱敏', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-log-'))
    const logger = new AppLogger(directory, { level: 'info', now: () => new Date('2026-11-03T00:00:00.000Z') })
    await Promise.all([
      logger.log('debug', 'ignored', { value: 1 }),
      logger.log('info', 'first', { password: 'plain-secret', nested: { token: 'plain-token', ok: 1 } }),
      logger.log('warn', 'second', { message: 'safe' }),
    ])
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).not.toContain('ignored')
    expect(text).not.toContain('plain-secret')
    expect(text).not.toContain('plain-token')
    expect(text).toContain('[REDACTED]')
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })

  it('轮转后总文件数不超过上限', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-log-'))
    const logger = new AppLogger(directory, { maxBytes: 100, maxFiles: 5 })
    for (let index = 0; index < 12; index += 1) await logger.log('info', `event-${index}`, { value: 'x'.repeat(40) })
    await logger.close()
    const files = (await readdir(directory)).filter((name) => name.startsWith('app.log'))
    expect(files).toHaveLength(5)
    expect(files).toContain('app.log.4')
  })

  it('目录不可写时降级且不抛原始错误', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = new AppLogger(join(tmpdir(), `missing-${Date.now()}`, 'file\0bad'))
    await expect(logger.log('error', 'failure')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith('[term-manager] application log write failed')
    spy.mockRestore()
  })

  it('超长行截断、close 后不再写入、status 可读', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-log-'))
    const logger = new AppLogger(directory, { level: 'warn' })
    await logger.log('info', 'filtered')
    await logger.log('warn', 'long', { data: 'x'.repeat(20 * 1024) })
    await logger.close()
    await logger.log('error', 'after-close')
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('"truncated":true')
    expect(text).not.toContain('filtered')
    expect(text).not.toContain('after-close')
    const status = await new AppLogger(directory).status()
    expect(status.directory).toBe(directory)
    expect(status.files.length).toBeGreaterThan(0)
  })
})

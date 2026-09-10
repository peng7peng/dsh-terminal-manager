import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'

describe('port-log 应用日志', () => {
  it('按级别过滤、串行写入并递归脱敏', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory, { level: 'info', now: () => new Date('2026-09-03T00:00:00.000Z') })
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

  it('轮转后总文件数不超过配置上限', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory, { maxBytes: 100, maxFiles: 5 })
    for (let index = 0; index < 12; index += 1) {
      await logger.log('info', `event-${index}`, { value: 'x'.repeat(40) })
    }
    await logger.close()

    const files = (await readdir(directory)).filter((name) => name.startsWith('app.log'))
    expect(files).toHaveLength(5)
    expect(files).toContain('app.log')
    expect(files).toContain('app.log.4')
  })

  it('日志目录不可写时安全降级且不抛出原始错误', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = new AppLogger(join(tmpdir(), `missing-${Date.now()}`, 'file\0bad'))
    await expect(logger.log('error', 'failure')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith('[term-manager:port-log] application log write failed')
    spy.mockRestore()
  })

  it('setLevel 动态调整级别后过滤低级别日志', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory, { level: 'error' })
    logger.setLevel('info')
    await logger.log('info', 'visible-after-set')
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('visible-after-set')
  })

  it('status 返回当前级别、目录、文件列表', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory, { level: 'warn' })
    await logger.log('warn', 'event-1')
    await logger.close()
    const status = await new AppLogger(directory, { level: 'warn' }).status()
    expect(status.level).toBe('warn')
    expect(status.directory).toBe(directory)
    expect(status.files.length).toBeGreaterThan(0)
    expect(status.files[0]?.path).toContain('app.log')
  })

  it('超长日志行被截断为 truncated 标记', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory)
    await logger.log('info', 'long-event', { data: 'x'.repeat(20 * 1024) })
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('"truncated":true')
  })

  it('循环引用对象被标记为 [Circular]', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory)
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    await logger.log('info', 'circular', obj)
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('[Circular]')
  })

  it('数组字段被递归脱敏', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory)
    await logger.log('info', 'array', { items: [{ password: 'a' }, { token: 'b' }] })
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).not.toContain('"a"')
    expect(text).not.toContain('"b"')
    expect(text).toContain('[REDACTED]')
  })

  it('close 后 log 返回已完成队列且不再写入', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory)
    await logger.log('info', 'before-close')
    await logger.close()
    await logger.log('info', 'after-close')
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('before-close')
    expect(text).not.toContain('after-close')
  })

  it('debug 级别启用后写入 debug 日志', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory, { level: 'debug' })
    await logger.log('debug', 'debug-event', { value: 42 })
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    expect(text).toContain('DEBUG debug-event')
  })

  it('字符串字段中的换行符被替换为空格', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-port-log-'))
    const logger = new AppLogger(directory)
    await logger.log('info', 'multi-line', { text: 'line1\nline2\r\nline3' })
    await logger.close()
    const text = await readFile(join(directory, 'app.log'), 'utf8')
    // 换行符被替换为空格，JSON 中不会有字面换行
    const logLine = text.split('\n').find((line) => line.includes('multi-line'))
    expect(logLine).toBeDefined()
    expect(logLine!.includes('line1 line2')).toBe(true)
  })
})

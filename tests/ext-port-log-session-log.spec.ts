import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../src/event-bus.ts'
import { AppLogger } from '../src/ext/port-log/app-logger.ts'
import { RuntimeEventHub } from '../src/ext/port-log/sse.ts'
import { SessionLogManager } from '../src/ext/port-log/session-log-manager.ts'
import type { SessionManagerApi, SessionSnapshot } from '../src/types/session-api.ts'

async function fixture(maxPendingBytes?: number, now?: () => Date): Promise<{
  manager: SessionLogManager
  events: ReturnType<typeof createEventBus>
  snapshot: SessionSnapshot
  logger: AppLogger
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'tm-session-log-'))
  const events = createEventBus()
  const snapshot: SessionSnapshot = { sessionId: 'session-sensitive-label', label: 'user@secret-host', target: 'target', protocol: 'ssh', status: 'open' }
  const sessions = { events, get: () => snapshot, list: () => [snapshot] } as unknown as SessionManagerApi
  const logger = new AppLogger(join(directory, 'app'))
  return {
    manager: new SessionLogManager(join(directory, 'sessions'), sessions, events, logger, new RuntimeEventHub(), maxPendingBytes, now),
    events, snapshot, logger, directory: join(directory, 'sessions'),
  }
}

describe('port-log 会话输出日志', () => {
  it('默认不开启；开启后只记录 output，不记录 input', async () => {
    const { manager, events, logger } = await fixture(undefined, () => new Date(2026, 8, 8, 14, 5, 6))
    expect(manager.list()).toEqual([])
    const started = await manager.start('session-sensitive-label', { timestamp: false, stripAnsi: true })
    expect(basename(started.path)).toBe('user@secret-host(2026-09-08_14-05-06-000).log')
    events.emit({ type: 'input', sessionId: 'session-sensitive-label', data: 'direct-secret-input', source: 'human', ts: Date.now() })
    events.emit({ type: 'output', sessionId: 'session-sensitive-label', data: '\x1b[31mdevice-output\x1b[0m\n', ts: Date.now() })
    await manager.stop('session-sensitive-label')
    const text = await readFile(started.path, 'utf8')
    expect(text).toBe('device-output\n')
    expect(text).not.toContain('direct-secret-input')
    await logger.close()
  })

  it('每次重新开始存盘都创建不同时间戳的日志文件', async () => {
    const now = () => new Date(2026, 8, 8, 14, 5, 6, 123)
    const { manager, logger } = await fixture(undefined, now)
    const first = await manager.start('session-sensitive-label', { timestamp: true, stripAnsi: true })
    await manager.stop('session-sensitive-label')
    const second = await manager.start('session-sensitive-label', { timestamp: true, stripAnsi: true })
    await manager.stop('session-sensitive-label')

    expect(basename(first.path)).toBe('user@secret-host(2026-09-08_14-05-06-123).log')
    expect(basename(second.path)).toBe('user@secret-host(2026-09-08_14-05-06-124).log')
    expect(second.path).not.toBe(first.path)
    await logger.close()
  })

  it('同一会话的并发启动请求共用一个日志任务', async () => {
    const { manager, logger } = await fixture(undefined, () => new Date(2026, 8, 8, 14, 5, 6, 123))
    const [first, second] = await Promise.all([
      manager.start('session-sensitive-label', { timestamp: true, stripAnsi: true }),
      manager.start('session-sensitive-label', { timestamp: true, stripAnsi: true }),
    ])

    expect(second.path).toBe(first.path)
    expect(manager.list()).toHaveLength(1)
    await manager.stop('session-sensitive-label')
    await logger.close()
  })

  it('会话关闭时刷出半行，文件不轮转也不自动删除', async () => {
    const { manager, events, snapshot, logger, directory } = await fixture()
    const started = await manager.start('session-sensitive-label', { timestamp: false, stripAnsi: false })
    events.emit({ type: 'output', sessionId: 'session-sensitive-label', data: 'unfinished', ts: Date.now() })
    snapshot.status = 'closed'
    events.emit({ type: 'status', sessionId: 'session-sensitive-label', status: 'closed', snapshot, ts: Date.now() })
    await vi.waitFor(() => expect(manager.list()).toEqual([]))
    expect(await readFile(started.path, 'utf8')).toBe('unfinished\n')
    expect(await readdir(directory)).toHaveLength(1)
    await logger.close()
  })

  it('待写数据超过限制时自动停写', async () => {
    const { manager, events, logger } = await fixture(5)
    await manager.start('session-sensitive-label', { timestamp: false, stripAnsi: true })
    events.emit({ type: 'output', sessionId: 'session-sensitive-label', data: 'too-long\n', ts: Date.now() })
    await vi.waitFor(() => expect(manager.list()).toEqual([]))
    await logger.close()
  })
})

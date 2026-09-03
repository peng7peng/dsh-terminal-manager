import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TmEvent, TmEventBus } from '../../types/events.ts'
import type { SessionManagerApi } from '../../types/session-api.ts'
import type { AppLogger } from './app-logger.ts'
import { PortLogError } from './errors.ts'
import type { RuntimeEventHub } from './sse.ts'
import { TerminalTextNormalizer } from './terminal-text-normalizer.ts'
import type { SessionLogOptions, SessionLogSnapshot } from './types.ts'

interface LogRuntime {
  sessionId: string
  path: string
  options: SessionLogOptions
  normalizer: TerminalTextNormalizer
  stream: WriteStream
  unsubscribe: () => void
  bytesWritten: number
  pendingBytes: number
  queue: Promise<void>
  stopping: boolean
  failed: boolean
  lastError?: string
}

export class SessionLogManager {
  private readonly logs = new Map<string, LogRuntime>()
  private closing = false

  constructor(
    private readonly directory: string,
    private readonly sessions: SessionManagerApi,
    private readonly sessionEvents: TmEventBus,
    private readonly logger: AppLogger,
    private readonly events: RuntimeEventHub,
    private readonly maxPendingBytes = 1024 * 1024,
  ) {}

  list(): SessionLogSnapshot[] {
    return [...this.logs.values()].map((runtime) => this.snapshot(runtime))
  }

  async start(sessionId: string, options: SessionLogOptions): Promise<SessionLogSnapshot> {
    if (this.closing) throw new PortLogError('MAPPING_STATE', '扩展正在关闭')
    if (this.logs.has(sessionId)) throw new PortLogError('VALIDATION', '该会话日志已经开启')
    if (this.sessions.get(sessionId)?.status !== 'open') throw new PortLogError('VALIDATION', '只能记录已打开的会话')
    this.validateOptions(options)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = sessionId.replace(/[^a-z\d-]/gi, '').slice(0, 8) || 'session'
    const path = join(this.directory, `${safeId}-${stamp}.log`)
    const stream = createWriteStream(path, { flags: 'wx', mode: 0o600, encoding: 'utf8' })
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    }).catch(() => { throw new PortLogError('IO_ERROR', '会话日志文件无法创建') })
    const runtime: LogRuntime = {
      sessionId, path, options: { ...options }, normalizer: new TerminalTextNormalizer(options), stream,
      unsubscribe: () => undefined, bytesWritten: 0, pendingBytes: 0,
      queue: Promise.resolve(), stopping: false, failed: false,
    }
    runtime.unsubscribe = this.sessionEvents.on(
      (event) => this.handleEvent(runtime, event),
      { type: ['output', 'status'], sessionId },
    )
    stream.on('error', () => this.fail(runtime, '会话日志写入失败'))
    this.logs.set(sessionId, runtime)
    await this.logger.log('info', 'session_log.started', { sessionId, path, timestamp: options.timestamp, stripAnsi: options.stripAnsi })
    this.publish(runtime)
    return this.snapshot(runtime)
  }

  async update(sessionId: string, options: SessionLogOptions): Promise<SessionLogSnapshot> {
    const runtime = this.requireRuntime(sessionId)
    this.validateOptions(options)
    const tail = runtime.normalizer.flush()
    if (tail.length > 0) this.enqueueWrite(runtime, tail)
    runtime.options = { ...options }
    runtime.normalizer = new TerminalTextNormalizer(options)
    this.publish(runtime)
    return this.snapshot(runtime)
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId)
    await this.stopRuntime(runtime)
  }

  async closeAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.logs.values()].map((runtime) => this.stopRuntime(runtime)))
  }

  private handleEvent(runtime: LogRuntime, event: TmEvent): void {
    if (runtime.stopping || runtime.failed) return
    if (event.type === 'status') {
      if (event.status === 'closed' || event.status === 'removed') void this.stopRuntime(runtime)
      return
    }
    if (event.type !== 'output') return
    const text = runtime.normalizer.push(event.data)
    if (text.length > 0) this.enqueueWrite(runtime, text)
  }

  private enqueueWrite(runtime: LogRuntime, text: string): void {
    const bytes = Buffer.byteLength(text)
    if (runtime.pendingBytes + bytes > this.maxPendingBytes) {
      this.fail(runtime, '会话日志写入积压超过限制')
      return
    }
    runtime.pendingBytes += bytes
    runtime.queue = runtime.queue.then(() => new Promise<void>((resolve, reject) => {
      runtime.stream.write(text, 'utf8', (error) => error ? reject(error) : resolve())
    })).then(() => {
      runtime.pendingBytes -= bytes
      runtime.bytesWritten += bytes
      this.publish(runtime)
    }).catch(() => {
      runtime.pendingBytes -= bytes
      this.fail(runtime, '会话日志写入失败')
    })
  }

  private fail(runtime: LogRuntime, message: string): void {
    if (runtime.failed || runtime.stopping) return
    runtime.failed = true
    runtime.lastError = message
    this.publish(runtime)
    void this.logger.log('error', 'session_log.failed', { sessionId: runtime.sessionId, code: 'IO_BACKPRESSURE' })
    void this.stopRuntime(runtime)
  }

  private async stopRuntime(runtime: LogRuntime): Promise<void> {
    if (runtime.stopping) return runtime.queue
    runtime.stopping = true
    runtime.unsubscribe()
    const tail = runtime.normalizer.flush()
    if (tail.length > 0 && !runtime.failed) this.enqueueWrite(runtime, tail)
    await runtime.queue.catch(() => undefined)
    await new Promise<void>((resolve) => {
      if (runtime.stream.closed) resolve()
      else runtime.stream.end(() => resolve())
    })
    this.logs.delete(runtime.sessionId)
    await this.logger.log('info', 'session_log.stopped', { sessionId: runtime.sessionId, bytesWritten: runtime.bytesWritten })
    this.events.publish({ type: 'session-log-status', data: { sessionId: runtime.sessionId, state: 'stopped', path: runtime.path, bytesWritten: runtime.bytesWritten, ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }) } })
  }

  private requireRuntime(sessionId: string): LogRuntime {
    const runtime = this.logs.get(sessionId)
    if (runtime === undefined) throw new PortLogError('VALIDATION', '该会话日志未开启')
    return runtime
  }

  private validateOptions(options: SessionLogOptions): void {
    if (typeof options.timestamp !== 'boolean' || typeof options.stripAnsi !== 'boolean') {
      throw new PortLogError('VALIDATION', '会话日志选项无效')
    }
  }

  private snapshot(runtime: LogRuntime): SessionLogSnapshot {
    return {
      sessionId: runtime.sessionId,
      state: runtime.failed ? 'error' : 'running',
      path: runtime.path,
      bytesWritten: runtime.bytesWritten,
      ...runtime.options,
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
    }
  }

  private publish(runtime: LogRuntime): void {
    this.events.publish({ type: 'session-log-status', data: this.snapshot(runtime) })
  }
}

import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppLogStatus, LogLevel } from './types.ts'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const SENSITIVE_KEY = /^(password|privatekey|passphrase|authorization|token|secret|credential)$/i
const MAX_LINE_BYTES = 16 * 1024

interface LoggerOptions {
  level?: LogLevel
  maxBytes?: number
  maxFiles?: number
  now?: () => Date
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ')
    return value
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, seen)
  }
  return result
}

export class AppLogger {
  readonly directory: string
  readonly currentFile: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly now: () => Date
  private level: LogLevel
  private size = 0
  private ready?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private lastError?: string

  constructor(directory: string, options: LoggerOptions = {}) {
    this.directory = directory
    this.currentFile = join(directory, 'app.log')
    this.level = options.level ?? 'info'
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.maxFiles = options.maxFiles ?? 5
    this.now = options.now ?? (() => new Date())
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (this.closed || LEVEL_RANK[level] < LEVEL_RANK[this.level]) return this.queue
    this.queue = this.queue.then(async () => {
      try {
        await this.ensureReady()
        let line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} ${JSON.stringify(sanitize(fields))}\n`
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} {"truncated":true}\n`
        }
        const bytes = Buffer.byteLength(line)
        if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate()
        const file = await open(this.currentFile, 'a', 0o600)
        try {
          await file.writeFile(line, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
        this.size += bytes
      } catch {
        this.lastError = '应用日志写入失败'
        console.error('[term-manager:port-log] application log write failed')
      }
    })
    return this.queue
  }

  async status(): Promise<AppLogStatus> {
    await this.queue
    await this.ensureReady()
    const names = (await readdir(this.directory)).filter((name) => /^app\.log(?:\.\d+)?$/.test(name)).sort()
    const files = await Promise.all(names.map(async (name) => {
      const path = join(this.directory, name)
      return { path, bytes: (await stat(path)).size }
    }))
    return {
      level: this.level,
      directory: this.directory,
      currentFile: this.currentFile,
      files,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.queue
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try {
        this.size = (await stat(this.currentFile)).size
      } catch {
        this.size = 0
      }
    })()
    await this.ready
  }

  private async rotate(): Promise<void> {
    const oldest = join(this.directory, `app.log.${this.maxFiles - 1}`)
    await rm(oldest, { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      try {
        await rename(join(this.directory, `app.log.${index}`), join(this.directory, `app.log.${index + 1}`))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try {
      await rename(this.currentFile, join(this.directory, 'app.log.1'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.size = 0
  }
}

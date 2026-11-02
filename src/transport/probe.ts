/**
 * 连接探针 —— 不建立会话/不开 shell，只验证设备是否可达、SSH 能否认证。
 *
 * Telnet：TCP connect 成功即视为可达（无认证概念）。
 * SSH：握手 + 认证到 ready 后立即 end（不建 Transport、不开 PTY）。
 * 错误只映射成统一码 + 人类可读原因，message 永不含凭据。
 * @module dsh-terminal-manager/transport/probe
 */

import * as net from 'node:net'
import { Client } from 'ssh2'
import type { ConnectionConfig } from '../connection-store.ts'

/** 探针默认超时（毫秒）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

export type ProbeCode = 'AUTH_FAILED' | 'HOST_UNREACHABLE' | 'CONN_TIMEOUT' | 'PROTO_ERROR'

export interface ProbeResult {
  connId: string
  label: string
  protocol: 'ssh' | 'telnet'
  ok: boolean
  /** 成功时的往返耗时（毫秒）。 */
  latencyMs?: number
  /** 失败时的统一错误码。 */
  code?: ProbeCode
  /** 失败原因（不含凭据）。 */
  reason?: string
}

/** 把底层异常映射成统一探针错误码。 */
export function probeCodeOf(error: unknown): ProbeCode {
  const err = error as NodeJS.ErrnoException & { level?: string }
  if (err.level === 'client-authentication') return 'AUTH_FAILED'
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'HOST_UNREACHABLE'
    case 'ETIMEDOUT':
      return 'CONN_TIMEOUT'
    default:
      return 'PROTO_ERROR'
  }
}

function reasonOf(code: ProbeCode): string {
  switch (code) {
    case 'AUTH_FAILED': return '认证失败'
    case 'HOST_UNREACHABLE': return '无法连接'
    case 'CONN_TIMEOUT': return '连接超时'
    default: return '协议错误'
  }
}

/** 探测一条已保存的连接。 */
export function probeConnection(cfg: ConnectionConfig, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const started = Date.now()
  const base = { connId: cfg.id, label: cfg.label, protocol: cfg.protocol }
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    const finish = (result: Omit<ProbeResult, 'connId' | 'label' | 'protocol'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...base, ...result })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'CONN_TIMEOUT', reason: reasonOf('CONN_TIMEOUT') })
    }, timeoutMs)

    if (cfg.protocol === 'telnet') {
      const socket = net.connect({ host: cfg.host, port: cfg.port })
      socket.once('connect', () => {
        finish({ ok: true, latencyMs: Date.now() - started })
        socket.destroy()
      })
      socket.once('error', (error) => {
        const code = probeCodeOf(error)
        finish({ ok: false, code, reason: reasonOf(code) })
        socket.destroy()
      })
      return
    }

    const client = new Client()
    client.once('ready', () => {
      finish({ ok: true, latencyMs: Date.now() - started })
      client.end()
    })
    client.once('error', (error) => {
      const code = probeCodeOf(error)
      finish({ ok: false, code, reason: reasonOf(code) })
      try { client.end() } catch { /* 已断开 */ }
    })
    try {
      client.connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username ?? '',
        ...(cfg.auth?.kind === 'password' ? { password: cfg.auth.password } : {}),
        ...(cfg.auth?.kind === 'key' ? { privateKey: cfg.auth.privateKey, ...(cfg.auth.passphrase !== undefined ? { passphrase: cfg.auth.passphrase } : {}) } : {}),
        readyTimeout: timeoutMs,
        hostVerifier: () => true,
      })
    } catch (error) {
      const code = probeCodeOf(error)
      finish({ ok: false, code, reason: reasonOf(code) })
    }
  })
}

/** 批量探测；并发上限 5（对齐主设计文档）。 */
export async function probeMany(cfgs: readonly ConnectionConfig[], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (let i = 0; i < cfgs.length; i += 5) {
    results.push(...await Promise.all(cfgs.slice(i, i + 5).map(cfg => probeConnection(cfg, timeoutMs))))
  }
  return results
}

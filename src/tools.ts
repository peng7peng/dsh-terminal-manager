/**
 * B6 AI 工具层 —— AI 的六只"手"。
 *
 * 把六个 tm_* 工具注册进 DSH 的 ctx.tools 给 AI 用；参数校验、结果格式转换、卡片呈现。
 * 只调 B4 会话管理器，不直接碰传输层。AI 路径的发送必过命令守卫（guard 传 {}）。
 * 会话不按 Agent 隔离——本插件是公共会话池，任何 AI 与人都操作同一批会话。
 * @module dsh-terminal-manager/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileService } from './types/file-service.ts'
import type { SessionSnapshot } from './session-manager.ts'
import { SessionManager, type WaitPolicyConfig } from './session-manager.ts'

/** 会话快照的 JSON schema（tm_connect / tm_list 复用）。 */
const SESSION_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    connId: { type: 'string' },
    label: { type: 'string', required: true },
    target: { type: 'string', required: true },
    protocol: { type: 'string', required: true, enum: ['ssh', 'telnet'] },
    status: { type: 'string', required: true, enum: ['connecting', 'open', 'closed', 'removed'] },
    openedAtMs: { type: 'number' },
    closeReason: { type: 'string' },
  },
} as const

/** tm_send 的输出：已执行完（默认）或发完即回。 */
const SEND_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'completed' },
        output: { type: 'string', required: true },
        waitReason: { type: 'string', required: true, enum: ['quiet', 'prompt', 'timeout'] },
        truncated: { type: 'boolean', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'submitted' },
      },
    },
  ],
} as const

/** tm_send_all 的广播条目。 */
const BROADCAST_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    outcome: { type: 'string', required: true, enum: ['ok', 'busy', 'disconnected', 'error'] },
    output: { type: 'string' },
    waitReason: { type: 'string', enum: ['quiet', 'prompt', 'timeout'] },
    code: { type: 'string' },
  },
} as const

/** tm_upload / tm_download 的输出（TransferResult）。 */
const TRANSFER_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    bytes: { type: 'number', required: true },
    durationMs: { type: 'number', required: true },
  },
} as const

interface ConnectArgs {
  connId?: string
  protocol?: string
  host?: string
  port?: number
  username?: string
  password?: string
  label?: string
}

interface TransferArgs {
  sessionId?: string
  localPath?: string
  remotePath?: string
}

interface SendArgs {
  sessionId: string
  command: string
  wait?: 'complete' | 'immediate'
  quietMs?: number
  timeoutMs?: number
}

interface SendAllArgs {
  command: string
  sessionIds?: string
  wait?: 'complete' | 'immediate'
  quietMs?: number
  timeoutMs?: number
}

interface ReadArgs {
  sessionId: string
  count?: number
}

function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
}

function waitOptions(args: { quietMs?: number; timeoutMs?: number }): { wait?: WaitPolicyConfig } {
  const wait: WaitPolicyConfig = {
    ...(args.quietMs !== undefined ? { quietMs: args.quietMs } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  }
  return Object.keys(wait).length > 0 ? { wait } : {}
}

/** FileServiceError / SessionError 带 code；折叠成「CODE: 消息」前缀便于 AI 自纠。 */
function recode(error: unknown): never {
  if (error instanceof Error && 'code' in error) throw new Error(`${String((error as { code: unknown }).code)}: ${error.message}`)
  throw error instanceof Error ? error : new Error(String(error))
}

/** B6 工具层依赖。 */
export interface TerminalToolDeps {
  sessions: SessionManager
  /** 文件服务（tm_upload / tm_download 用） */
  files: FileService
  /** 本地工作区树根（与 files.root 端点一致；工具的 localPath 围栏基准） */
  workspaceRoot: string
}

/** 注册 tm_* 工具。需在 ctx.tools / ctx.systemPrompt 就绪后调用。 */
export function registerTerminalTools(ctx: Context, deps: TerminalToolDeps): void {
  const { sessions, files, workspaceRoot } = deps
  ctx.systemPrompt.section({
    name: 'tool:term-manager',
    order: 107,
    text: '终端管理插件维护一批与人和 AI 共用的远程设备会话（SSH/Telnet）。先用 tm_list 查看会话；用 tm_connect 连接设备；tm_send 对单个会话发命令并等执行完拿回整段输出；tm_send_all 广播到多台；tm_read 读某会话当前屏幕；不用了 tm_disconnect 断开。同一会话一次只跑一条命令，忙碌会报 SESSION_BUSY。waitReason 为 timeout 不代表命令失败，可用 tm_read 复查。危险命令会被拦截并返回 COMMAND_BLOCKED。文件在工作区与 SSH 设备间用 tm_upload / tm_download 传输（localPath 是绝对路径，先用 files.root 工具查工作区树根；Telnet 会话不支持文件传输）。',
  })

  ctx.tools.register(defineTool({
    name: 'tm_connect',
    description: '连接一台远程设备，返回会话编号。两种方式二选一：① 传 connId 用已保存的连接；② 传 protocol+host（+port/username/password）建立临时连接（不入库）。',
    parameters: {
      connId: { type: 'string', description: '已保存连接的编号（优先）。省略则用下面的临时连接参数。' },
      protocol: { type: 'string', description: '临时连接协议：ssh 或 telnet' },
      host: { type: 'string', description: '临时连接 IP 地址' },
      port: { type: 'number', description: '临时连接端口（缺省 ssh=22 / telnet=23）' },
      username: { type: 'string', description: 'SSH 用户名（临时连接）' },
      password: { type: 'string', description: 'SSH 密码（临时连接）' },
      label: { type: 'string', description: '显示名（临时连接）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SESSION_SNAPSHOT_SCHEMA.properties,
          banner: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已连接 ${value.label}（${value.target}，${value.protocol}）会话 ${value.sessionId}\n${value.banner}` }],
    },
    async execute(args: ConnectArgs, _exec) {
      // 1. 如果传了 connId，直接用
      if (args.connId !== undefined && args.connId.length > 0) {
        const snap = await sessions.connectByConnId(args.connId)
        return { ...snap, banner: sessions.read(snap.sessionId, 200).text }
      }
      // 2. 否则先查有没有匹配的已保存连接（host:port）
      const protocol = args.protocol
      if (protocol !== 'ssh' && protocol !== 'telnet') throw new Error('需要 connId，或临时连接的 protocol（ssh|telnet）')
      const host = args.host?.trim()
      if (host === undefined || host.length === 0) throw new Error('临时连接需要 host（IP 地址）')
      const port = args.port ?? (protocol === 'ssh' ? 22 : 23)
      const existing = sessions.findConnectionByTarget(protocol, host, port)
      if (existing !== undefined) {
        // 找到已保存的连接，用它而不是建临时连接
        const snap = await sessions.connectByConnId(existing.connId)
        return { ...snap, banner: sessions.read(snap.sessionId, 200).text }
      }
      // 3. 没有匹配的，建临时连接
      if (protocol === 'ssh' && (args.username === undefined || args.username.length === 0)) throw new Error('SSH 临时连接需要 username')
      const snap = await sessions.connect({
        protocol,
        host,
        port,
        username: args.username,
        password: args.password,
        label: args.label,
      })
      return { ...snap, banner: sessions.read(snap.sessionId, 200).text }
    },
    presentCall: (args) => ({ card: 'generic', title: `连接设备 ${(args as ConnectArgs).label ?? (args as ConnectArgs).host ?? (args as ConnectArgs).connId ?? ''}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_list',
    description: '列出当前所有远程会话及其状态。',
    parameters: {},
    output: {
      schema: { type: 'array', items: SESSION_SNAPSHOT_SCHEMA },
      render: (_args, value) => {
        const list = value as SessionSnapshot[]
        return [{ type: 'text', text: list.length === 0 ? '（无会话）' : list.map(s => `${s.sessionId} ${s.label} [${s.protocol}] ${s.target} ${s.status}`).join('\n') }]
      },
    },
    execute(_args, _exec) {
      return sessions.list()
    },
    presentCall: () => ({ card: 'generic', title: '列出会话', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_send',
    description: '向一个会话发送命令。默认等待执行完成（静默/提示符/超时判定）后整段返回；wait=immediate 则发完即回（用 tm_read 观察长命令）。危险命令会被拦截。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '会话编号（tm_connect 或 tm_list 返回）' },
      command: { type: 'string', required: true, description: '要发送的命令文本' },
      wait: { type: 'string', description: 'complete（默认，等执行完）或 immediate（发完即回）' },
      quietMs: { type: 'number', description: '静默判定毫秒数（覆盖连接配置）' },
      timeoutMs: { type: 'number', description: '超时兜底毫秒数（覆盖连接配置）' },
    },
    output: {
      schema: SEND_RESULT_SCHEMA,
      render: (_args, value) => {
        if (value.kind === 'submitted') return [{ type: 'text', text: '已发送（未等待执行完成，可用 tm_read 观察）' }]
        const v = value as { output: string; waitReason: string; truncated: boolean }
        return [{ type: 'text', text: v.output + (v.truncated ? '\n[输出截断]' : '') }]
      },
    },
    async execute(args: SendArgs, exec) {
      if (args.command.length === 0) throw new Error('command 不能为空')
      if (args.wait === 'immediate') {
        await sessions.sendImmediate(args.sessionId, args.command, { guard: {}, signal: exec.signal })
        return { kind: 'submitted' as const }
      }
      const result = await sessions.sendAndWait(args.sessionId, args.command, {
        guard: {},
        signal: exec.signal,
        ...waitOptions(args),
      })
      return { kind: 'completed' as const, ...result }
    },
    presentCall(args) {
      const parsed = args as Partial<SendArgs>
      return { card: 'terminal', title: parsed.command || '(发送命令)', description: `会话 ${parsed.sessionId ?? ''}` }
    },
    presentResult(args, result) {
      if ((args as Partial<SendArgs>).wait === 'immediate' || result.isError) return undefined
      const raw = textOf(result.content)
      return raw === undefined || raw.length === 0 ? undefined : { card: 'terminal', output: raw }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tm_send_all',
    description: '广播一条命令到多台设备（默认全部打开的会话），逐台独立执行并汇总结果。sessionIds 用逗号分隔。',
    parameters: {
      command: { type: 'string', required: true, description: '要广播的命令文本' },
      sessionIds: { type: 'string', description: '逗号分隔的目标会话编号；缺省=全部打开的会话' },
      wait: { type: 'string', description: 'complete（默认）或 immediate' },
      quietMs: { type: 'number', description: '静默判定毫秒数' },
      timeoutMs: { type: 'number', description: '超时兜底毫秒数' },
    },
    output: {
      schema: { type: 'array', items: BROADCAST_ENTRY_SCHEMA },
      render: (_args, value) => {
        const entries = value as Array<{ sessionId: string; outcome: string; output?: string; code?: string }>
        return [{ type: 'text', text: entries.map(e => `${e.sessionId}: ${e.outcome}${e.output !== undefined ? `\n${e.output}` : ''}${e.code !== undefined ? ` [${e.code}]` : ''}`).join('\n---\n') }]
      },
    },
    async execute(args: SendAllArgs, exec) {
      if (args.command.length === 0) throw new Error('command 不能为空')
      const targetIds = args.sessionIds !== undefined && args.sessionIds.trim() !== ''
        ? args.sessionIds.split(',').map(s => s.trim()).filter(s => s.length > 0)
        : undefined
      if (args.wait === 'immediate') {
        const ids = targetIds ?? sessions.list().filter(s => s.status === 'open').map(s => s.sessionId)
        const entries = []
        for (const id of ids) {
          try {
            await sessions.sendImmediate(id, args.command, { guard: {}, signal: exec.signal })
            entries.push({ sessionId: id, outcome: 'ok' as const })
          } catch (error) {
            entries.push({ sessionId: id, outcome: 'error' as const, code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'PROTO_ERROR' })
          }
        }
        return entries
      }
      const raw = await sessions.broadcast(args.command, targetIds, {
        guard: {},
        signal: exec.signal,
        ...waitOptions(args),
      })
      // 展平 result 到 schema 认可的 output/waitReason（schema additionalProperties:false）
      return raw.map(e => ({
        sessionId: e.sessionId,
        outcome: e.outcome,
        ...(e.result?.output !== undefined ? { output: e.result.output } : {}),
        ...(e.result?.waitReason !== undefined ? { waitReason: e.result.waitReason } : {}),
        ...(e.code !== undefined ? { code: e.code } : {}),
      }))
    },
    presentCall: (args) => ({ card: 'generic', title: `广播命令：${(args as SendAllArgs).command}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_read',
    description: '读取某会话当前的屏幕缓冲（不发命令）。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '会话编号' },
      count: { type: 'number', description: '返回最近多少行（缺省 500）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          totalLines: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { text: string }
        return [{ type: 'text', text: v.text }]
      },
    },
    execute(args: ReadArgs, _exec) {
      return sessions.read(args.sessionId, args.count ?? 500)
    },
    presentCall: (args) => ({ card: 'generic', title: `读取会话 ${(args as ReadArgs).sessionId}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_disconnect',
    description: '断开会话。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '会话编号' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          outcome: { type: 'string', required: true, enum: ['closed'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已断开会话 ${(value as { sessionId: string }).sessionId}` }],
    },
    async execute(args: { sessionId: string }, _exec) {
      await sessions.disconnect(args.sessionId)
      return { sessionId: args.sessionId, outcome: 'closed' as const }
    },
    presentCall: (args) => ({ card: 'generic', title: `断开会话 ${(args as { sessionId: string }).sessionId}`, kind: 'delete' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_upload',
    description: '把本机工作区文件上传到远端设备（仅 SSH 会话；Telnet 会话报 UNSUPPORTED）。localPath 必须是工作区树根内的绝对路径——先用 files.root 工具查树根。远端同名文件会被覆盖。',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'SSH 会话编号（tm_connect / tm_list 返回）' },
      localPath: { type: 'string', required: true, description: '本机文件绝对路径（必须在工作区树根内；先调 files.root 查）' },
      remotePath: { type: 'string', required: true, description: '远端绝对路径（POSIX 风格，如 /root/app.log）' },
    },
    output: {
      schema: TRANSFER_RESULT_SCHEMA,
      render: (args, value) => {
        const v = value as { bytes: number; durationMs: number }
        return [{ type: 'text', text: `已上传 ${v.bytes} 字节 → ${(args as TransferArgs).remotePath}（${v.durationMs}ms）` }]
      },
    },
    async execute(args: TransferArgs, _exec) {
      if (args.sessionId === undefined || args.sessionId.length === 0) throw new Error('需要 sessionId（SSH 会话编号）')
      if (args.localPath === undefined || args.localPath.length === 0) throw new Error('需要 localPath（本机文件绝对路径，先调 files.root 查工作区树根）')
      if (args.remotePath === undefined || args.remotePath.length === 0) throw new Error('需要 remotePath（远端绝对路径）')
      try {
        return await files.upload({
          sessionId: args.sessionId,
          remotePath: args.remotePath,
          source: { kind: 'local', ref: { root: workspaceRoot, path: args.localPath } },
        })
      } catch (error) {
        recode(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `上传 ${(args as TransferArgs).localPath ?? ''} → ${(args as TransferArgs).remotePath ?? ''}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tm_download',
    description: '把远端设备文件下载到本机工作区（仅 SSH 会话；Telnet 会话报 UNSUPPORTED）。localPath 必填（工作区树根内的绝对路径，先调 files.root 查树根）；下载完成后可用 files.read 工具读取内容。本机同名文件会被覆盖。',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'SSH 会话编号（tm_connect / tm_list 返回）' },
      remotePath: { type: 'string', required: true, description: '远端绝对路径（POSIX 风格）' },
      localPath: { type: 'string', required: true, description: '本机保存位置绝对路径（必须在工作区树根内；先调 files.root 查）' },
    },
    output: {
      schema: TRANSFER_RESULT_SCHEMA,
      render: (args, value) => {
        const v = value as { bytes: number; durationMs: number }
        return [{ type: 'text', text: `已下载 ${(args as TransferArgs).remotePath}，${v.bytes} 字节 → ${(args as TransferArgs).localPath}（${v.durationMs}ms）；可用 files.read 读取` }]
      },
    },
    async execute(args: TransferArgs, _exec) {
      if (args.sessionId === undefined || args.sessionId.length === 0) throw new Error('需要 sessionId（SSH 会话编号）')
      if (args.remotePath === undefined || args.remotePath.length === 0) throw new Error('需要 remotePath（远端绝对路径）')
      if (args.localPath === undefined || args.localPath.length === 0) throw new Error('需要 localPath（本机保存位置绝对路径，先调 files.root 查工作区树根）')
      try {
        return await files.downloadToLocal({
          sessionId: args.sessionId,
          remotePath: args.remotePath,
          target: { root: workspaceRoot, path: args.localPath },
        })
      } catch (error) {
        recode(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `下载 ${(args as TransferArgs).remotePath ?? ''} → ${(args as TransferArgs).localPath ?? ''}`, kind: 'execute' }),
  }))
}

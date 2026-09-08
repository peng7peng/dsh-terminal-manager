import { useSyncExternalStore } from 'react'
import { portLogRpc } from './rpc.ts'

export interface ClientMapping {
  id: string
  protocol: 'tcp' | 'udp'
  localAddr: string
  localPort: number
  redirectAddr: string
  redirectPort: number
  autoStart: boolean
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  activeCount: number
  bytesClientToTarget: number
  bytesTargetToClient: number
  lastError?: string
}

export interface ClientSession { sessionId: string; label: string; target: string; protocol: 'ssh' | 'telnet'; status: string }
export interface ClientShare {
  sessionId: string; localAddr: string; sharePort: number; maxClients: number; welcomeMessage: string
  state: string; lastError?: string
  clients: Array<{ id: string; remoteAddress: string; connectedAtMs: number; bytesToClient: number; bytesFromClient: number }>
}
export interface ClientSessionLog {
  sessionId: string; state: string; path: string; bytesWritten: number; timestamp: boolean; stripAnsi: boolean; lastError?: string
}
export interface ClientAppLog {
  level: string; directory: string; currentFile: string; files: Array<{ path: string; bytes: number }>; lastError?: string
}

export interface PortLogState {
  visible: boolean
  loading: boolean
  error?: string
  mappings: ClientMapping[]
  sessions: ClientSession[]
  shares: ClientShare[]
  sessionLogs: ClientSessionLog[]
  appLog?: ClientAppLog
  defaultLogDirectory: string
}

let state: PortLogState = { visible: false, loading: false, mappings: [], sessions: [], shares: [], sessionLogs: [], defaultLogDirectory: '' }
const listeners = new Set<() => void>()

function emit(): void { for (const listener of listeners) listener() }
function replace(patch: Partial<PortLogState>): void { state = { ...state, ...patch }; emit() }
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

export function usePortLogState(): PortLogState { return useSyncExternalStore(subscribe, () => state) }
export function getPortLogState(): PortLogState { return state }
export function setPortLogVisible(visible: boolean): void { replace({ visible }) }
export function togglePortLogVisible(): void { setPortLogVisible(!state.visible) }
export function setDefaultLogDirectory(directory: string): void { replace({ defaultLogDirectory: directory }) }
export function getDefaultLogDirectory(): string { return state.defaultLogDirectory }
let defaultDirectoryRequest: Promise<string> | undefined
/** 在连接面板初始化时加载，不依赖用户先打开端口映射窗口。 */
export async function loadDefaultLogDirectory(): Promise<string> {
  if (state.defaultLogDirectory) return state.defaultLogDirectory
  if (!defaultDirectoryRequest) {
    defaultDirectoryRequest = portLogRpc<{ directory: string }>('sessionLogs.defaultDirectory').then(({ directory }) => {
      if (!directory?.trim()) throw new Error('默认日志目录未就绪，请重试')
      setDefaultLogDirectory(directory)
      return directory
    }).finally(() => { defaultDirectoryRequest = undefined })
  }
  return defaultDirectoryRequest
}
export function setPortLogLoading(loading: boolean): void { replace({ loading }) }
export function setPortLogError(error?: string): void { replace({ error }) }
export function setPortLogSnapshot(patch: Pick<PortLogState, 'mappings' | 'sessions' | 'shares' | 'sessionLogs' | 'appLog'>): void { replace(patch) }

export function applyPortLogEvent(type: string, data: unknown): void {
  const item = data as { id?: string; sessionId?: string; state?: string }
  if (type === 'mapping-status' && item.id !== undefined) {
    const mapping = data as ClientMapping
    replace({ mappings: state.mappings.some((entry) => entry.id === mapping.id) ? state.mappings.map((entry) => entry.id === mapping.id ? mapping : entry) : [...state.mappings, mapping] })
  } else if (type === 'mapping-removed' && item.id !== undefined) {
    replace({ mappings: state.mappings.filter((entry) => entry.id !== item.id) })
  } else if (type === 'share-status' && item.sessionId !== undefined) {
    const share = data as ClientShare
    replace({ shares: state.shares.some((entry) => entry.sessionId === share.sessionId) ? state.shares.map((entry) => entry.sessionId === share.sessionId ? share : entry) : [...state.shares, share] })
  } else if (type === 'share-removed' && item.sessionId !== undefined) {
    replace({ shares: state.shares.filter((entry) => entry.sessionId !== item.sessionId) })
  } else if (type === 'session-log-status' && item.sessionId !== undefined) {
    if (item.state === 'stopped') replace({ sessionLogs: state.sessionLogs.filter((entry) => entry.sessionId !== item.sessionId) })
    else {
      const log = data as ClientSessionLog
      replace({ sessionLogs: state.sessionLogs.some((entry) => entry.sessionId === log.sessionId) ? state.sessionLogs.map((entry) => entry.sessionId === log.sessionId ? log : entry) : [...state.sessionLogs, log] })
    }
  } else if (type === 'app-log-status') replace({ appLog: data as ClientAppLog })
}

export type MappingSort = 'localPort' | 'protocol' | 'state' | 'bytes'
export function sortMappings(mappings: readonly ClientMapping[], sort: MappingSort): ClientMapping[] {
  return [...mappings].sort((left, right) => {
    if (sort === 'localPort') return left.localPort - right.localPort || left.localAddr.localeCompare(right.localAddr)
    if (sort === 'protocol') return left.protocol.localeCompare(right.protocol) || left.localPort - right.localPort
    if (sort === 'state') return left.state.localeCompare(right.state) || left.localPort - right.localPort
    return (right.bytesClientToTarget + right.bytesTargetToClient) - (left.bytesClientToTarget + left.bytesTargetToClient)
  })
}

export function canStartShare(riskConfirmed: boolean): boolean { return riskConfirmed }

export type MappingProtocol = 'tcp' | 'udp'
export type MappingState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PortMappingConfig {
  id: string
  protocol: MappingProtocol
  localAddr: string
  localPort: number
  redirectAddr: string
  redirectPort: number
  autoStart: boolean
}

export type PortMappingInput = Omit<PortMappingConfig, 'id'>

export interface MappingSnapshot extends PortMappingConfig {
  state: MappingState
  activeCount: number
  bytesClientToTarget: number
  bytesTargetToClient: number
  lastError?: string
}

export interface ForwarderStats {
  activeCount: number
  bytesClientToTarget: number
  bytesTargetToClient: number
  lastError?: string
}

export interface AppLogStatus {
  level: LogLevel
  directory: string
  currentFile: string
  files: Array<{ path: string; bytes: number }>
  lastError?: string
}

export interface ShareConfig {
  sessionId: string
  localAddr: string
  sharePort: number
  maxClients: number
  welcomeMessage: string
}

export interface ShareClientSnapshot {
  id: string
  remoteAddress: string
  connectedAtMs: number
  bytesToClient: number
  bytesFromClient: number
}

export interface ShareSnapshot extends ShareConfig {
  state: 'running' | 'stopped' | 'error'
  clients: ShareClientSnapshot[]
  lastError?: string
}

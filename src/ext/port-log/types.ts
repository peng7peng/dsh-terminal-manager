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

export interface AppLogStatus {
  level: LogLevel
  directory: string
  currentFile: string
  files: Array<{ path: string; bytes: number }>
  lastError?: string
}

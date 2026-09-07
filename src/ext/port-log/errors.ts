export const PORT_LOG_ERROR_CODES = [
  'VALIDATION', 'PORT_IN_USE', 'ADDRESS_INVALID', 'TARGET_UNREACHABLE',
  'MAPPING_NOT_FOUND', 'MAPPING_STATE', 'SHARE_ALREADY_ACTIVE',
  'SHARE_NOT_FOUND', 'IO_ERROR', 'IO_BACKPRESSURE', 'IMPORT_INVALID',
] as const

export type PortLogErrorCode = typeof PORT_LOG_ERROR_CODES[number]

export class PortLogError extends Error {
  constructor(
    public readonly code: PortLogErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'PortLogError'
  }
}

export function safeError(error: unknown): { code: PortLogErrorCode; message: string } {
  if (error instanceof PortLogError) return { code: error.code, message: error.message }
  return { code: 'IO_ERROR', message: '操作失败，请查看应用日志' }
}

import { PortLogError } from './errors.ts'
import { validateMappingInput } from './mapping-store.ts'
import type { PortMappingConfig, PortMappingInput } from './types.ts'

const MAX_CSV_BYTES = 1024 * 1024
const MAX_CSV_ROWS = 1000

function parseRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.trim().length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (quoted) throw new PortLogError('IMPORT_INVALID', 'CSV 引号未闭合')
  row.push(field)
  if (row.some((value) => value.trim().length > 0)) rows.push(row)
  return rows
}

function parseEndpoint(value: string, line: number, field: string): { address: string; port: number } {
  const trimmed = value.trim()
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(trimmed)
  const regular = /^(.+):(\d+)$/.exec(trimmed)
  const match = ipv6 ?? regular
  if (match === null) throw new PortLogError('IMPORT_INVALID', `第 ${line} 行 ${field} 格式无效`, { line, field })
  return { address: match[1]!, port: Number(match[2]) }
}

function parseBoolean(value: string, line: number): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0' || normalized === '') return false
  throw new PortLogError('IMPORT_INVALID', `第 ${line} 行 autoStart 格式无效`, { line, field: 'autoStart' })
}

export function parseMappingsCsv(source: string | Buffer): PortMappingInput[] {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : source
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new PortLogError('IMPORT_INVALID', 'CSV 文件不能超过 1 MiB')
  const rows = parseRows(text.replace(/^\uFEFF/, ''))
  if (rows[0]?.[0]?.trim().toLowerCase() === 'protocol') rows.shift()
  if (rows.length > MAX_CSV_ROWS) throw new PortLogError('IMPORT_INVALID', 'CSV 最多包含 1000 条映射')

  return rows.map((columns, index) => {
    const line = index + 1
    try {
      let input: PortMappingInput
      if (columns.length === 3) {
        const local = parseEndpoint(columns[1]!, line, 'local')
        const redirect = parseEndpoint(columns[2]!, line, 'redirect')
        input = {
          protocol: columns[0]!.trim().toLowerCase() as PortMappingInput['protocol'],
          localAddr: local.address,
          localPort: local.port,
          redirectAddr: redirect.address,
          redirectPort: redirect.port,
          autoStart: false,
        }
      } else if (columns.length === 5 || columns.length === 6) {
        input = {
          protocol: columns[0]!.trim().toLowerCase() as PortMappingInput['protocol'],
          localAddr: columns[1]!.trim(),
          localPort: Number(columns[2]),
          redirectAddr: columns[3]!.trim(),
          redirectPort: Number(columns[4]),
          autoStart: columns.length === 6 ? parseBoolean(columns[5]!, line) : false,
        }
      } else {
        throw new PortLogError('IMPORT_INVALID', `第 ${line} 行字段数必须是 3、5 或 6`, { line })
      }
      return validateMappingInput(input)
    } catch (error) {
      if (error instanceof PortLogError && error.code === 'IMPORT_INVALID') throw error
      throw new PortLogError('IMPORT_INVALID', `第 ${line} 行配置无效`, { line })
    }
  })
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function exportMappingsCsv(mappings: readonly PortMappingConfig[]): string {
  const rows = mappings.map((item) => [
    item.protocol,
    item.localAddr,
    String(item.localPort),
    item.redirectAddr,
    String(item.redirectPort),
    String(item.autoStart),
  ].map(quote).join(','))
  return ['protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart', ...rows].join('\r\n') + '\r\n'
}

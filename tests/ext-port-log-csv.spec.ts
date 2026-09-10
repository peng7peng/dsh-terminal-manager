import { describe, expect, it } from 'vitest'
import { exportMappingsCsv, parseMappingsCsv } from '../src/ext/port-log/csv.ts'

describe('port-log CSV', () => {
  it('兼容 BOM、空行、5/6 字段并处理双引号', () => {
    const rows = parseMappingsCsv('\uFEFFprotocol,localAddr,localPort,redirectAddr,redirectPort,autoStart\r\n\r\ntcp,127.0.0.1,80,"example.com",8080,true\r\nudp,::1,81,localhost,8081\r\n')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ protocol: 'tcp', autoStart: true })
    expect(rows[1]).toMatchObject({ protocol: 'udp', localAddr: '::1', autoStart: false })
  })

  it('兼容 IPOP 三字段和方括号 IPv6 端点', () => {
    const [item] = parseMappingsCsv('tcp,[::1]:8022,[2001:db8::1]:22\n')
    expect(item).toEqual({
      protocol: 'tcp', localAddr: '::1', localPort: 8022,
      redirectAddr: '2001:db8::1', redirectPort: 22, autoStart: false,
    })
  })

  it('导出再导入保持字段一致并使用 CRLF', () => {
    const mappings = [{
      id: 'mapping-1', protocol: 'tcp' as const, localAddr: '0.0.0.0', localPort: 1000,
      redirectAddr: 'localhost', redirectPort: 2000, autoStart: true,
    }]
    const csv = exportMappingsCsv(mappings)
    expect(csv).toContain('\r\n')
    expect(parseMappingsCsv(csv)).toEqual(mappings.map(({ id: _id, ...item }) => item))
  })

  it('错误包含安全行号但不回显整行', () => {
    expect(() => parseMappingsCsv('tcp,not-an-endpoint,127.0.0.1:22\n')).toThrow(/第 1 行/)
    expect(() => parseMappingsCsv('tcp,not-an-endpoint,127.0.0.1:22\n')).not.toThrow(/not-an-endpoint/)
  })

  it('CSV 超过 1 MiB 抛出 IMPORT_INVALID', () => {
    expect(() => parseMappingsCsv('x'.repeat(1024 * 1024 + 1))).toThrow(/CSV 文件不能超过/)
  })

  it('CSV 超过 1000 行抛出 IMPORT_INVALID', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `tcp,127.0.0.1,${10000 + i},localhost,22`).join('\n')
    expect(() => parseMappingsCsv(rows)).toThrow(/CSV 最多包含/)
  })

  it('CSV 引号未闭合抛出 IMPORT_INVALID', () => {
    expect(() => parseMappingsCsv('tcp,"unclosed,127.0.0.1,80,localhost,22\n')).toThrow(/CSV 引号未闭合/)
  })

  it('autoStart 无效值抛出 IMPORT_INVALID', () => {
    expect(() => parseMappingsCsv('tcp,127.0.0.1,80,localhost,22,maybe\n')).toThrow(/autoStart 格式无效/)
  })

  it('autoStart 空字符串视为 false', () => {
    const [item] = parseMappingsCsv('tcp,127.0.0.1,80,localhost,22,\n')
    expect(item.autoStart).toBe(false)
  })

  it('autoStart 为 1 视为 true', () => {
    const [item] = parseMappingsCsv('tcp,127.0.0.1,80,localhost,22,1\n')
    expect(item.autoStart).toBe(true)
  })

  it('autoStart 为 0 视为 false', () => {
    const [item] = parseMappingsCsv('tcp,127.0.0.1,80,localhost,22,0\n')
    expect(item.autoStart).toBe(false)
  })

  it('字段数不为 3/5/6 抛出 IMPORT_INVALID', () => {
    expect(() => parseMappingsCsv('tcp,127.0.0.1\n')).toThrow(/字段数必须是/)
    expect(() => parseMappingsCsv('tcp,127.0.0.1,80,localhost\n')).toThrow(/字段数必须是/)
    expect(() => parseMappingsCsv('tcp,127.0.0.1,80,localhost,22,true,extra\n')).toThrow(/字段数必须是/)
  })

  it('Buffer 输入被正确解析', () => {
    const [item] = parseMappingsCsv(Buffer.from('tcp,127.0.0.1,80,localhost,22\n', 'utf8'))
    expect(item.protocol).toBe('tcp')
    expect(item.localPort).toBe(80)
  })

  it('三字段格式解析 IPv6 端点', () => {
    const [item] = parseMappingsCsv('udp,[::1]:8022,[2001:db8::1]:22\n')
    expect(item.localAddr).toBe('::1')
    expect(item.localPort).toBe(8022)
    expect(item.redirectAddr).toBe('2001:db8::1')
    expect(item.redirectPort).toBe(22)
  })

  it('导出包含逗号的字段用双引号包裹', () => {
    const csv = exportMappingsCsv([{
      id: 'm1', protocol: 'tcp', localAddr: '0.0.0.0', localPort: 1000,
      redirectAddr: 'host,with,comma', redirectPort: 2000, autoStart: true,
    }])
    expect(csv).toContain('"host,with,comma"')
  })

  it('空 CSV 返回空数组', () => {
    expect(parseMappingsCsv('')).toEqual([])
    expect(parseMappingsCsv('\n\n')).toEqual([])
  })

  it('仅含表头行返回空数组', () => {
    expect(parseMappingsCsv('protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart\n')).toEqual([])
  })
})

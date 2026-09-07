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
})

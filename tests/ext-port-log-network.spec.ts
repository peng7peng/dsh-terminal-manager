import { describe, expect, it } from 'vitest'
import { localAddresses, validateLocalAddress, validateTarget } from '../src/ext/port-log/network.ts'

describe('port-log 网络工具', () => {
  it('固定通配地址在前并去重排序', () => {
    const result = localAddresses({
      one: [
        { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null },
        { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null },
      ],
    })
    expect(result).toEqual(['0.0.0.0', '::', '127.0.0.1'])
  })

  it('监听地址只接受 IP，目标可接受域名', () => {
    expect(validateLocalAddress(' ::1 ')).toBe('::1')
    expect(() => validateLocalAddress('localhost')).toThrow()
    expect(validateTarget('Example.COM')).toBe('example.com')
    expect(() => validateTarget('-bad.example')).toThrow()
  })
})

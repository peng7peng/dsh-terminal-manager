import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('插件 Config schema', () => {
  it('schema 校验空对象填默认值', () => {
    const value = Config({})
    expect(value).toEqual({ workspaceRoot: '', telnetFileTransfer: true })
  })

  it('schema 保留用户给的值', () => {
    const value = Config({ workspaceRoot: 'D:/dut', telnetFileTransfer: false })
    expect(value).toEqual({ workspaceRoot: 'D:/dut', telnetFileTransfer: false })
  })

  it('schema 拒绝类型不对的值', () => {
    expect(() => Config({ workspaceRoot: 123 as unknown as string })).toThrow()
  })

  it('resolveConfig：空 / 空白 / 缺省 workspaceRoot 落到 cwd；显式值 trim 后保留', () => {
    const cwd = () => 'D:/cwd'
    expect(resolveConfig(undefined, cwd)).toEqual({ workspaceRoot: 'D:/cwd', telnetFileTransfer: true })
    expect(resolveConfig({ workspaceRoot: '   ' }, cwd).workspaceRoot).toBe('D:/cwd')
    expect(resolveConfig({ workspaceRoot: ' D:/x ' }, cwd).workspaceRoot).toBe('D:/x')
    expect(resolveConfig({ telnetFileTransfer: false }, cwd).telnetFileTransfer).toBe(false)
  })
})

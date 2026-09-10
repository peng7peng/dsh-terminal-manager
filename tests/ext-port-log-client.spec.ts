import { afterEach, describe, expect, it, vi } from 'vitest'
import { portLogRpc } from '../client/ext/port-log/rpc.ts'
import {
  applyPortLogEvent, canStartShare, getPortLogState, setPortLogSnapshot,
  loadDefaultLogDirectory, setDefaultLogDirectory,
  setPortLogVisible, sortMappings, togglePortLogVisible,
  type ClientMapping,
} from '../client/ext/port-log/store.ts'

const mapping = (id: string, localPort: number, state: ClientMapping['state'], bytes = 0): ClientMapping => ({
  id, protocol: id === 'udp' ? 'udp' : 'tcp', localAddr: '127.0.0.1', localPort,
  redirectAddr: 'localhost', redirectPort: 22, autoStart: false, state,
  activeCount: 0, bytesClientToTarget: bytes, bytesTargetToClient: 0,
})

afterEach(() => {
  vi.unstubAllGlobals()
  setPortLogVisible(false)
  setDefaultLogDirectory('')
  setPortLogSnapshot({ mappings: [], sessions: [], shares: [], sessionLogs: [], appLog: undefined })
})

describe('port-log 客户端模型', () => {
  it('未打开端口映射时也能加载默认日志目录，并复用请求和缓存', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: { ok: true, value: { directory: 'C:\\用户\\日志' } },
    })))
    vi.stubGlobal('fetch', fetchMock)
    expect(getPortLogState().visible).toBe(false)
    await expect(Promise.all([loadDefaultLogDirectory(), loadDefaultLogDirectory()])).resolves.toEqual(['C:\\用户\\日志', 'C:\\用户\\日志'])
    expect(getPortLogState().defaultLogDirectory).toBe('C:\\用户\\日志')
    await expect(loadDefaultLogDirectory()).resolves.toBe('C:\\用户\\日志')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('默认日志目录为空时报告错误，下一次允许重新加载', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { ok: true, value: { directory: '' } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { ok: true, value: { directory: '/logs' } } })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadDefaultLogDirectory()).rejects.toThrow('默认日志目录未就绪')
    await expect(loadDefaultLogDirectory()).resolves.toBe('/logs')
  })

  it('可见性独立切换且共享风险未确认时禁止启动', () => {
    expect(getPortLogState().visible).toBe(false)
    togglePortLogVisible()
    expect(getPortLogState().visible).toBe(true)
    expect(canStartShare(false)).toBe(false)
    expect(canStartShare(true)).toBe(true)
  })

  it('列表排序不修改原数组', () => {
    const source = [mapping('b', 2000, 'running', 10), mapping('udp', 1000, 'stopped', 30)]
    expect(sortMappings(source, 'localPort').map((item) => item.id)).toEqual(['udp', 'b'])
    expect(sortMappings(source, 'bytes').map((item) => item.id)).toEqual(['udp', 'b'])
    expect(source.map((item) => item.id)).toEqual(['b', 'udp'])
  })

  it('SSE 增量状态更新和删除', () => {
    applyPortLogEvent('mapping-status', mapping('one', 1000, 'running'))
    applyPortLogEvent('mapping-status', mapping('one', 1000, 'stopped'))
    expect(getPortLogState().mappings).toMatchObject([{ id: 'one', state: 'stopped' }])
    applyPortLogEvent('mapping-removed', { id: 'one' })
    expect(getPortLogState().mappings).toEqual([])
  })

  it('RPC 沿用统一错误格式', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: { ok: false, error: { code: 'PORT_IN_USE', message: '监听端口已被占用' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(portLogRpc('mappings.start', { id: 'one' })).rejects.toMatchObject({ code: 'PORT_IN_USE' })
  })
})

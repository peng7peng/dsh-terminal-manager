import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MappingStore } from '../src/ext/port-log/mapping-store.ts'
import type { PortMappingInput } from '../src/ext/port-log/types.ts'

const base: PortMappingInput = {
  protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18080,
  redirectAddr: 'localhost', redirectPort: 28080, autoStart: false,
}

describe('port-log 映射存储', () => {
  it('创建、更新、删除并跨实例加载 version 1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    const store = new MappingStore(path)
    await store.ensureLoaded()
    const created = await store.create(base)
    await store.update(created.id, { autoStart: true })

    const loaded = new MappingStore(path)
    await loaded.ensureLoaded()
    expect(loaded.list()).toMatchObject([{ ...base, id: created.id, autoStart: true }])
    await loaded.remove(created.id)
    expect(JSON.parse(await readFile(path, 'utf8')).mappings).toEqual([])
  })

  it('拒绝无效端口、非 IP 监听地址和重复监听键', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await store.create(base)
    await expect(store.create(base)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(store.create({ ...base, localPort: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(store.create({ ...base, localAddr: 'localhost', localPort: 18081 })).rejects.toMatchObject({ code: 'ADDRESS_INVALID' })
  })

  it('损坏配置返回安全 I/O 错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    await writeFile(path, '{"version":2}', 'utf8')
    await expect(new MappingStore(path).ensureLoaded()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('merge 在任一条无效时零新增', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.merge([base, { ...base, localPort: 0 }])).rejects.toBeTruthy()
    expect(store.list()).toEqual([])
  })

  it('merge 出现重复监听键时零新增', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.merge([base, base])).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(store.list()).toEqual([])
  })

  it('update 不存在的 id 抛 MAPPING_NOT_FOUND', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.update('nonexistent', { autoStart: true })).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND' })
  })

  it('remove 不存在的 id 抛 MAPPING_NOT_FOUND', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.remove('nonexistent')).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND' })
  })

  it('未加载就调用 list 抛 IO_ERROR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    expect(() => store.list()).toThrow(/端口映射配置尚未加载/)
  })

  it('未加载就调用 create 抛 IO_ERROR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await expect(store.create(base)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('update 改协议为 udp 并跨实例持久化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    const store = new MappingStore(path)
    await store.ensureLoaded()
    const created = await store.create(base)
    const updated = await store.update(created.id, { protocol: 'udp', redirectPort: 38080 })
    expect(updated.protocol).toBe('udp')
    expect(updated.redirectPort).toBe(38080)

    const loaded = new MappingStore(path)
    await loaded.ensureLoaded()
    expect(loaded.list()[0]?.protocol).toBe('udp')
    expect(loaded.list()[0]?.redirectPort).toBe(38080)
  })

  it('update 后监听键与自身重复时仍允许（excludingId）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    const created = await store.create(base)
    const updated = await store.update(created.id, { autoStart: true })
    expect(updated.autoStart).toBe(true)
    expect(updated.id).toBe(created.id)
  })

  it('update 后监听键与其他映射冲突抛 VALIDATION', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    const first = await store.create(base)
    const second = await store.create({ ...base, localPort: 18081 })
    await expect(store.update(second.id, { localPort: first.localPort })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('ensureLoaded 幂等，重复调用不重复读取', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    const store = new MappingStore(path)
    await store.ensureLoaded()
    await store.create(base)
    await store.ensureLoaded()
    expect(store.list()).toHaveLength(1)
  })

  it('拒绝非布尔 autoStart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.create({ ...base, autoStart: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('拒绝未知协议', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'mappings.json'))
    await store.ensureLoaded()
    await expect(store.create({ ...base, protocol: 'icmp' as unknown as 'tcp' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('损坏的 mappings 数组（含重复 id）返回 IO_ERROR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    const config = { id: 'dup', protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18080, redirectAddr: 'localhost', redirectPort: 28080, autoStart: false }
    await writeFile(path, JSON.stringify({ version: 1, mappings: [config, config] }), 'utf8')
    await expect(new MappingStore(path).ensureLoaded()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('损坏的 mappings 数组（含重复监听键）返回 IO_ERROR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    const a = { id: 'a', protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18080, redirectAddr: 'localhost', redirectPort: 28080, autoStart: false }
    const b = { id: 'b', protocol: 'tcp', localAddr: '127.0.0.1', localPort: 18080, redirectAddr: 'localhost', redirectPort: 28080, autoStart: false }
    await writeFile(path, JSON.stringify({ version: 1, mappings: [a, b] }), 'utf8')
    await expect(new MappingStore(path).ensureLoaded()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('空文件视为 IO_ERROR（JSON 解析失败）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const path = join(directory, 'mappings.json')
    await writeFile(path, '', 'utf8')
    await expect(new MappingStore(path).ensureLoaded()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('文件不存在时视为空映射列表', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tm-mapping-'))
    const store = new MappingStore(join(directory, 'never-exists.json'))
    await store.ensureLoaded()
    expect(store.list()).toEqual([])
  })
})

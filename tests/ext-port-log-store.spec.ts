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
})

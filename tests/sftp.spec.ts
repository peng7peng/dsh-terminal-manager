/**
 * SFTP 门面测试（S5 步骤2）：内嵌 mock sftp 服务器（tests/helpers.ts 的 startSftpDevice，后端 = 真实临时目录）。
 * 覆盖 list / stat / mkdirs / put（本地路径与流来源、同名覆盖、中断清理）/ get / downloadStream / 进度回调 / 错误映射。
 */
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { SftpFacade } from '../src/transport/sftp.ts'
import type { SftpLike, Transport } from '../src/transport/types.ts'
import { createDeviceLab } from './helpers.ts'

describe('SFTP 门面（S5 步骤2）', () => {
  const lab = createDeviceLab()
  let root = ''
  let transport: Transport | undefined
  let sftp: SftpLike | undefined

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    sftp = undefined
    await lab.cleanup()
    if (root) await fsp.rm(root, { recursive: true, force: true })
    root = ''
  })

  /** 起设备、连 SSH、开门面；root 为本机临时目录（即 SFTP 的 '/'） */
  const start = async (): Promise<void> => {
    root = await fsp.mkdtemp(nodePath.join(tmpdir(), 'tm-sftp-'))
    const { port } = await lab.startSftpDevice(root)
    transport = await connectSsh({ host: '127.0.0.1', port, username: 'admin', password: 'test-pass' }, { onData: () => {}, onClose: () => {} })
    sftp = await transport.getSftp!()
  }

  const localFile = async (name: string, content: string | Buffer): Promise<string> => {
    const p = nodePath.join(root, name)
    await fsp.writeFile(p, content)
    return p
  }
  const leftovers = async (): Promise<string[]> => (await fsp.readdir(root)).filter((n) => n.includes('.tm-partial-'))

  it('put（本地路径来源）：内容落位、无半成品残留、返回字节数', async () => {
    await start()
    const local = await localFile('src.txt', 'hello sftp')
    const res = await sftp!.put({ kind: 'path', path: local }, '/dst.txt')
    expect(res.bytes).toBe(10)
    expect(await fsp.readFile(nodePath.join(root, 'dst.txt'), 'utf8')).toBe('hello sftp')
    expect(await leftovers()).toEqual([])
  })

  it('put（流来源）：内容落位；进度回调终值 = 总大小', async () => {
    await start()
    const data = Buffer.alloc(256 * 1024, 0x61)
    const seen: Array<{ t: number; total?: number }> = []
    const res = await sftp!.put(
      { kind: 'stream', stream: Readable.from([data]), size: data.length },
      '/big.bin',
      { onProgress: (t, total) => seen.push({ t, total }) },
    )
    expect(res.bytes).toBe(data.length)
    expect(await fsp.readFile(nodePath.join(root, 'big.bin'))).toEqual(data)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toEqual({ t: data.length, total: data.length })
  })

  it('put 覆盖同名：旧内容被替换（走「改名失败 → 删旧再改」回退）', async () => {
    await start()
    await fsp.writeFile(nodePath.join(root, 'app.log'), 'old-old-old')
    const local = await localFile('new.txt', 'new-content')
    await sftp!.put({ kind: 'path', path: local }, '/app.log')
    expect(await fsp.readFile(nodePath.join(root, 'app.log'), 'utf8')).toBe('new-content')
    expect(await leftovers()).toEqual([])
  })

  it('put 中断：半成品被清理、旧目标不受影响', async () => {
    await start()
    await fsp.writeFile(nodePath.join(root, 'keep.log'), 'original')
    const broken = new Readable({ read() { this.push('partial-data'); this.destroy(new Error('boom')) } })
    await expect(sftp!.put({ kind: 'stream', stream: broken }, '/keep.log')).rejects.toMatchObject({ code: 'REMOTE_IO' })
    expect(await fsp.readFile(nodePath.join(root, 'keep.log'), 'utf8')).toBe('original')
    expect(await leftovers()).toEqual([])
  })

  it('get：往返一致，返回字节数与远端大小', async () => {
    await start()
    const content = 'round-trip 内容'
    const local = await localFile('a.txt', content)
    await sftp!.put({ kind: 'path', path: local }, '/rt.txt')
    const out = nodePath.join(root, 'back.txt')
    const res = await sftp!.get('/rt.txt', out)
    expect(await fsp.readFile(out, 'utf8')).toBe(content)
    const st = await fsp.stat(nodePath.join(root, 'rt.txt'))
    expect(res.bytes).toBe(st.size)
    expect(res.size).toBe(st.size)
  })

  it('get 错误分支：不存在 → NOT_FOUND；超上限 → FILE_TOO_LARGE；目标是目录 → VALIDATION', async () => {
    await start()
    await expect(sftp!.get('/nope.txt', nodePath.join(root, 'x'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const local = await localFile('m.txt', '12345')
    await sftp!.put({ kind: 'path', path: local }, '/m.txt')
    await expect(sftp!.get('/m.txt', nodePath.join(root, 'y'), { maxBytes: 2 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await fsp.mkdir(nodePath.join(root, 'sub'))
    await expect(sftp!.get('/sub', nodePath.join(root, 'z'))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('list：名称 / 类型 / 大小 / 路径；空目录返回空数组', async () => {
    await start()
    expect(await sftp!.list('/')).toEqual([])
    await localFile('f1.txt', '0123456789')
    await fsp.mkdir(nodePath.join(root, 'd1'))
    const entries = await sftp!.list('/')
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('f1.txt')).toMatchObject({ path: '/f1.txt', kind: 'file', size: 10 })
    expect(byName.get('d1')).toMatchObject({ path: '/d1', kind: 'dir' })
    expect(await sftp!.list('/d1')).toEqual([])
  })

  it('stat：文件与目录的判断、大小', async () => {
    await start()
    const local = await localFile('s.txt', 'abc')
    await sftp!.put({ kind: 'path', path: local }, '/s.txt')
    const st = await sftp!.stat('/s.txt')
    expect(st.isFile).toBe(true)
    expect(st.isDirectory).toBe(false)
    expect(st.size).toBe(3)
    await fsp.mkdir(nodePath.join(root, 'sd'))
    expect((await sftp!.stat('/sd')).isDirectory).toBe(true)
  })

  it('mkdirs：逐级创建、幂等、中间有同名文件 → REMOTE_IO', async () => {
    await start()
    await sftp!.mkdirs('/a/b/c')
    expect((await fsp.stat(nodePath.join(root, 'a', 'b', 'c'))).isDirectory()).toBe(true)
    await sftp!.mkdirs('/a/b/c')
    await fsp.writeFile(nodePath.join(root, 'a', 'b', 'file'), 'x')
    await expect(sftp!.mkdirs('/a/b/file')).rejects.toMatchObject({ code: 'REMOTE_IO' })
  })

  it('downloadStream：流内容一致并带 size；进度回调终值 = 总大小', async () => {
    await start()
    const data = Buffer.alloc(128 * 1024 + 7, 0x62)
    const local = await localFile('ds.bin', data)
    await sftp!.put({ kind: 'path', path: local }, '/ds.bin')
    const seen: Array<{ t: number; total?: number }> = []
    const { stream, size } = await sftp!.downloadStream('/ds.bin', { onProgress: (t, total) => seen.push({ t, total }) })
    expect(size).toBe(data.length)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve())
      stream.on('error', (e) => reject(e))
    })
    expect(Buffer.concat(chunks)).toEqual(data)
    expect(seen[seen.length - 1]).toEqual({ t: data.length, total: data.length })
  })
})

describe('SFTP 门面：下载取消传播（审查 M1，stub SFTPWrapper 直测门面）', () => {
  it('消费端中止返回流 → 底层 SFTP 读流被销毁（不再从设备拉数据）', async () => {
    const rs = new Readable({ read() { /* 挂起等数据 */ } })
    const wrapper = {
      lstat: (_p: string, cb: (e: unknown, st?: unknown) => void) => cb(undefined, {
        isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 100,
      }),
      createReadStream: () => rs,
    }
    const facade = new SftpFacade(wrapper as never)
    const { stream } = await facade.downloadStream('/big.bin')
    expect(rs.destroyed).toBe(false)
    // 浏览器取消下载 / 响应断开 → pipeline 销毁消费流
    stream.destroy()
    await new Promise(r => setTimeout(r, 20))
    expect(rs.destroyed).toBe(true)
  })

  it('正常读到 EOF 不误销毁（close 时 readableEnded 为真，不走 destroy 分支）', async () => {
    const payload = Buffer.from('done-data')
    const rs = Readable.from([payload])
    const wrapper = {
      lstat: (_p: string, cb: (e: unknown, st?: unknown) => void) => cb(undefined, {
        isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: payload.length,
      }),
      createReadStream: () => rs,
    }
    const facade = new SftpFacade(wrapper as never)
    const { stream } = await facade.downloadStream('/ok.bin')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    expect(Buffer.concat(chunks)).toEqual(payload)
    // rs 自身 autoDestroy 会在 EOF 后自毁（流的默认行为），这里验证的是：
    // out 的 close 到来时 rs 已完整读完（readableEnded），门面的守卫不会提前掐断它
    expect(rs.readableEnded).toBe(true)
  })
})

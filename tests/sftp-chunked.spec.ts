/**
 * SFTP 门面的分片上传原语（openWrite / replace / unlink）+ SftpConcurrentWriter 真路径。
 * 走 tests/helpers.ts 的 mock SFTP 设备（后端 = 本机临时目录），不碰真机。
 */
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh } from '../src/transport/ssh.ts'
import { SftpConcurrentWriter } from '../src/transport/sftp-concurrent-writer.ts'
import { UploadSessionManager } from '../src/upload-protocol.ts'
import type { SftpLike, Transport } from '../src/transport/types.ts'
import { createDeviceLab } from './helpers.ts'

describe('SFTP 门面：分片写入原语', () => {
  const lab = createDeviceLab()
  let root = ''
  let transport: Transport | undefined
  let sftp: SftpLike | undefined

  const start = async (): Promise<void> => {
    root = await fsp.mkdtemp(nodePath.join(tmpdir(), 'tm-sftp-chunk-'))
    const { port } = await lab.startSftpDevice(root)
    transport = await connectSsh(
      { host: '127.0.0.1', port, username: 'admin', auth: { kind: 'password' as const, password: 'test-pass' } },
      { onData: () => {}, onClose: () => {} },
    )
    sftp = await transport.getSftp!()
  }

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    sftp = undefined
    await lab.cleanup()
    if (root) await fsp.rm(root, { recursive: true, force: true })
    root = ''
  })

  it('openWrite 乱序 position 写 → close → replace 原子落位 → unlink 幂等', async () => {
    await start()
    const handle = await sftp!.openWrite!('/part.bin', 'w')
    await handle.write(Buffer.from('ij'), 8)
    await handle.write(Buffer.from('abcd'), 0)
    await handle.write(Buffer.from('efgh'), 4)
    await handle.close()
    await handle.close() // 幂等

    expect(await fsp.readFile(nodePath.join(root, 'part.bin'), 'utf8')).toBe('abcdefghij')
    await sftp!.replace!('/part.bin', '/final.bin')
    expect(await fsp.readFile(nodePath.join(root, 'final.bin'), 'utf8')).toBe('abcdefghij')
    expect(await fsp.readdir(root)).toEqual(['final.bin'])

    await sftp!.unlink!('/final.bin')
    expect(await fsp.readdir(root)).toEqual([])
    await expect(sftp!.unlink!('/final.bin')).resolves.toBeUndefined()
  })

  it('r+ 保留已有内容；SftpConcurrentWriter 并发写大块', async () => {
    await start()
    await fsp.writeFile(nodePath.join(root, 'big.bin'), 'header')
    const writer = await SftpConcurrentWriter.open(sftp!, '/big.bin', {
      mode: 'r+', subPacketBytes: 64 * 1024, concurrency: 4,
    })
    const payload = Buffer.alloc(200 * 1024, 0x41)
    await writer.write(payload, 6)
    await writer.close()

    const actual = await fsp.readFile(nodePath.join(root, 'big.bin'))
    expect(actual.subarray(0, 6).toString('utf8')).toBe('header')
    expect(actual.subarray(6).equals(payload)).toBe(true)
  })

  it('错误映射：openWrite 父目录不存在 → NOT_FOUND；replace 源不存在 → NOT_FOUND', async () => {
    await start()
    await expect(sftp!.openWrite!('/no-such-dir/a.bin', 'w')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(sftp!.replace!('/missing.bin', '/a.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(sftp!.openWrite!('/missing.bin', 'r+')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('UploadSessionManager + 真实 SFTP：乱序分片 → complete 原子落位、无临时文件残留', async () => {
    await start()
    const dataDir = await fsp.mkdtemp(nodePath.join(tmpdir(), 'tm-upload-sftp-'))
    const manager = new UploadSessionManager({
      getSftp: async () => sftp!,
      dataDir,
      cleanupIntervalMs: 0,
    })
    try {
      const content = Buffer.from(`分片上传真实路径-${'A'.repeat(1000)}`, 'utf8')
      const created = await manager.create({
        sessionId: 's1', remotePath: '/chunked-final.bin', totalBytes: content.length, chunkSize: 128,
      })
      for (let index = created.totalChunks - 1; index >= 0; index--) {
        const offset = index * created.chunkSize
        const length = Math.min(created.chunkSize, content.length - offset)
        await manager.writeChunk(created.uploadId, index, content.subarray(offset, offset + length))
      }
      const status = await manager.status(created.uploadId)
      expect(status.receivedOffsets).toHaveLength(created.totalChunks)
      const done = await manager.complete(created.uploadId)
      expect(done).toEqual({ ok: true, bytes: content.length, remotePath: '/chunked-final.bin' })
      expect(await fsp.readFile(nodePath.join(root, 'chunked-final.bin'))).toEqual(content)
      const leftovers = (await fsp.readdir(root)).filter(name => name.includes('.dsh-tmp-'))
      expect(leftovers).toEqual([])
    } finally {
      await manager.closeAll()
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = process.cwd()

/** 起一个 mock-device 子进程，监听随机端口；返回 { port, stop }。 */
function startMockDevice(args: string[] = []): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(REPO, 'scripts/mock-device.mjs'), '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.on('error', reject)
    proc.stdout.setEncoding('utf8')
    const onData = (chunk: string): void => {
      const m = chunk.match(/监听 127\.0\.0\.1:(\d+)/)
      if (m !== null) {
        resolve({ port: Number(m[1]), stop: () => new Promise<void>((done) => { proc.kill(); done() }) })
      }
    }
    proc.stdout.on('data', onData)
  })
}

/** 连到设备，收到的所有字节攒到 buffer。 */
function talk(port: number): { send: (s: string) => void; text: () => string; close: () => Promise<void> } {
  const sock = createConnection({ host: '127.0.0.1', port })
  let buffer = ''
  sock.setEncoding('utf8')
  sock.on('data', (c: string) => { buffer += c })
  sock.on('error', () => { /* 设备被杀时 ECONNRESET，忽略 */ })
  return {
    send: (s) => { sock.write(s) },
    text: () => buffer,
    close: () => new Promise((done) => { sock.destroy(); done() }),
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('mock-device 退格钳制', () => {
  it('空行连发退格不会擦掉提示符 router>', async () => {
    const { port, stop } = await startMockDevice()
    try {
      const t = talk(port)
      await wait(150)
      const before = t.text()
      expect(before).toContain('router>')
      t.send('\x7f\x7f\x7f\x7f\x7f')
      await wait(150)
      const after = t.text()
      const added = after.slice(before.length)
      // 空行退格被钳制，不应回发任何退格字节
      expect(added).not.toContain('\x08')
      await t.close()
    } finally {
      await stop()
    }
  }, 10000)

  it('有输入时退格正常擦除，删到空行后不再退', async () => {
    const { port, stop } = await startMockDevice()
    try {
      const t = talk(port)
      await wait(150)
      t.send('abc')
      await wait(80)
      const afterType = t.text()
      t.send('\x7f\x7f\x7f\x7f\x7f')
      await wait(150)
      const afterDel = t.text()
      expect(afterType.slice(-4)).toContain('abc')
      const delAdded = afterDel.slice(afterType.length)
      // 3 个 DEL 删掉 abc → 回发 3 个退格；第 4/5 个被钳制
      const bsCount = (delAdded.match(/\x08/g) ?? []).length
      expect(bsCount).toBe(3)
      await t.close()
    } finally {
      await stop()
    }
  }, 10000)
})

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
const backspaces = (text: string): number => (text.match(/\x08/g) ?? []).length

/**
 * 轮询等待条件成立后返回。
 *
 * CI 负载高时，子进程的横幅可能晚于固定的 sleep 才写到 socket（曾因此断言到空字符串），
 * 所以凡是「等到某个输出出现」都改轮询，而不是猜一个等待毫秒数。
 */
async function waitUntil(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await wait(20)
  }
}

describe('mock-device 退格钳制', () => {
  it('空行连发退格不会擦掉提示符 router>', async () => {
    const { port, stop } = await startMockDevice()
    try {
      const t = talk(port)
      await waitUntil('mock 设备横幅里的 router> 提示符', () => t.text().includes('router>'))
      const before = t.text()
      t.send('\x7f\x7f\x7f\x7f\x7f')
      // 负向断言：先给「本不该出现的回退字节」留足到达时间，再确认一个都没有。
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
      await waitUntil('mock 设备横幅里的 router> 提示符', () => t.text().includes('router>'))
      t.send('abc')
      await waitUntil('abc 的回显', () => t.text().endsWith('abc'))
      const afterType = t.text()
      t.send('\x7f\x7f\x7f\x7f\x7f')
      await waitUntil('3 个退格回显', () => backspaces(t.text().slice(afterType.length)) >= 3)
      // 等第 4/5 个退格「若未被钳制则可能到达」的时间，再确认确实只有 3 个。
      await wait(150)
      const afterDel = t.text()
      expect(afterType.slice(-4)).toContain('abc')
      // 3 个 DEL 删掉 abc → 回发 3 个退格；第 4/5 个被钳制
      expect(backspaces(afterDel.slice(afterType.length))).toBe(3)
      await t.close()
    } finally {
      await stop()
    }
  }, 10000)
})

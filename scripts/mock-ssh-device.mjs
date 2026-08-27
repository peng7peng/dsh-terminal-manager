#!/usr/bin/env node
/**
 * 本地模拟 SSH 设备——给终端管理插件活测 SSH 连接用，无需真实 SSH 服务器。
 *
 * 用法：node scripts/mock-ssh-device.mjs [端口] [密码]
 *   默认端口 2222，密码 test-pass。
 *
 * 认证：用户名 admin + 密码（默认 test-pass），或任意密钥（都接受）。
 * 行为：连上发横幅 + prompt；支持 show version / show interface / ping / echo / help / exit。
 *
 * 在插件界面：新建 SSH 连接，主机 127.0.0.1、端口 2222、用户名 admin、密码 test-pass。
 */
import { createServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'

// ssh2 是 CJS，动态 import 拿 default
const ssh2mod = await import('ssh2')
const Server = ssh2mod.default?.Server ?? ssh2mod.Server

const PORT = Number(process.argv[2] ?? 2222)
const PASSWORD = process.argv[3] ?? 'test-pass'
const LABEL = `Mock SSH :${PORT}`

const hostKey = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

const HELP = `可用命令：
  show version            显示版本
  show interface          显示接口表
  ping <host>             ping 测试
  echo <text>             原样回显
  help                    本帮助
  exit                    断开
`

function banner() {
  return `\r\n${'='.repeat(40)}\r\n${LABEL}\r\nSoftware: MockSSHOS 2.0\r\nUp: ${new Date().toLocaleString()}\r\n${'='.repeat(40)}\r\n\r\nType 'help' for commands.\r\n\r\nssh> `
}

function respond(cmd) {
  const c = cmd.trim()
  if (c === '') return 'ssh> '
  if (c === 'help' || c === '?') return HELP + '\r\nssh> '
  if (c === 'show version') {
    return `MockSSHOS Version 2.0.1\r\nCompiled ${new Date().toISOString().slice(0, 10)}\r\n uptime 5 days\r\nssh> `
  }
  if (c === 'show interface') {
    return `Interface              Status\r\nEth0                   up\r\nEth1                   up\r\nssh> `
  }
  if (c.startsWith('ping ')) {
    const host = c.slice(5)
    const lines = ['Type escape sequence to abort.']
    for (let i = 0; i < 4; i++) lines.push(`!!!!! from ${host}: seq=${i} ttl=64 time=1.${i}ms`)
    lines.push('Success rate is 100% (4/4)')
    return lines.join('\r\n') + '\r\nssh> '
  }
  if (c.startsWith('echo ')) return c.slice(5) + '\r\nssh> '
  if (c === 'exit' || c === 'quit') return '\r\n[connection closed]\r\n'
  return `% Unknown command: "${c}"\r\nssh> `
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password') {
      return ctx.username === 'admin' && ctx.password === PASSWORD ? ctx.accept() : ctx.reject()
    }
    if (ctx.method === 'publickey') return ctx.accept()
    return ctx.reject()
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('window-change', (acceptWin) => acceptWin?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write(banner())
        let lineBuf = ''
        stream.on('data', (data) => {
          stream.write(data.toString('utf8').replace(/\r(?!\n)/g, '\r\n')) // 回显，\r→\r\n 防覆盖
          lineBuf += data.toString('utf8')
          let nl
          while ((nl = lineBuf.search(/[\r\n]/)) >= 0) {
            const line = lineBuf.slice(0, nl)
            lineBuf = lineBuf.slice(nl + 1).replace(/^\n/, '')
            const out = respond(line)
            stream.write(out)
            if (out.includes('connection closed')) { stream.end(); return }
          }
        })
      })
    })
  })
  client.on('error', () => { /* 客户端断开 */ })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ssh-device] ${LABEL} 已启动，监听 127.0.0.1:${PORT}`)
  console.log(`[mock-ssh-device] 在插件里新建 SSH 连接：主机 127.0.0.1 端口 ${PORT} 用户名 admin 密码 ${PASSWORD}`)
})

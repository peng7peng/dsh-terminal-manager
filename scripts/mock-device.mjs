#!/usr/bin/env node
/**
 * 本地模拟网络设备（路由器 CLI）—— 供终端管理插件本地联调，无需真实设备。
 *
 * 用法：node scripts/mock-device.mjs [端口]
 *   默认端口 2323。可起多个实例（2323 / 2324 …）测多会话/广播。
 *
 * 行为：Telnet 裸 TCP 连上后给横幅 + 提示符 `router> `；
 *   支持命令：show version / show interface / show ip interface brief /
 *             ping <host> / echo <text> / help / exit（断开）；
 *   其余命令回 `unknown command`。
 *
 * 在插件界面里：新建 Telnet 连接，主机 127.0.0.1、端口 2323（或你起的端口），
 * 用户名/密码留空（Telnet 不强制）。点连接即可看到横幅和提示符，敲命令有回显。
 * 想测提示符判定：连接配置里把「提示符正则」填 `router>\s*$`。
 */
import { createServer } from 'node:net'

const PORT = Number(process.argv[2] ?? 2323)
const USE_IAC = process.argv.includes('--iac')
const LABEL = `Mock Router :${PORT}`

const HELP = `可用命令：
  show version            显示版本
  show interface          显示接口表
  show ip interface brief 显示接口简要
  ping <host>             ping 测试
  echo <text>             原样回显
  help                    本帮助
  exit                    断开
`

function banner() {
  return `\r\n\x1b[36m${'='.repeat(40)}\r\n${LABEL}\r\nSoftware: MockOS 1.0 (local sim)\r\nUp: ${new Date().toLocaleString()}\r\n${'='.repeat(40)}\x1b[0m\r\n\r\nType 'help' for commands.\r\n\r\n\x1b[32mrouter>\x1b[0m `
}

function respond(cmd) {
  const c = cmd.trim()
  if (c === '') return '\x1b[32mrouter>\x1b[0m '
  if (c === 'help' || c === '?') return HELP + '\r\n\x1b[32mrouter>\x1b[0m '
  if (c === 'show version') {
    return `MockOS Version 1.0.4\nCompiled ${new Date().toISOString().slice(0, 10)}\n uptime 3 days, 2 hours\n\x1b[32mrouter>\x1b[0m `
  }
  if (c === 'show interface' || c === 'show ip interface brief') {
    return `Interface      Status    Protocol\nGig0/0         up        up\nGig0/1         up        up\nLoopback0      up        up\n\x1b[32mrouter>\x1b[0m `
  }
  if (c.startsWith('ping ')) {
    const host = c.slice(5)
    const lines = [`Type escape sequence to abort.`]
    for (let i = 0; i < 4; i++) lines.push(`!!!!! from ${host}: seq=${i} ttl=64 time=1.${i}ms`)
    lines.push(`Success rate is 100% (4/4)`)
    return lines.join('\r\n') + '\r\n\x1b[32mrouter>\x1b[0m '
  }
  if (c.startsWith('echo ')) return c.slice(5) + '\r\n\x1b[32mrouter>\x1b[0m '
  if (c === 'exit' || c === 'quit') return '\r\n\x1b[31m[connection closed]\x1b[0m\r\n'
  return `\x1b[31m% Unknown command: "${c}"\x1b[0m\r\n\x1b[32mrouter>\x1b[0m `
}

const server = createServer((socket) => {
  // IAC 模式：连接时发 IAC WILL ECHO + DO TERMINAL_TYPE（模拟真网络设备的协商请求）
  if (USE_IAC) {
    socket.write(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfd, 0x18])) // IAC WILL ECHO, IAC DO TERMINAL_TYPE
  }
  socket.write(banner())
  let lineBuf = ''
  socket.on('data', (chunk) => {
    const str = chunk.toString('utf8')
    // 逐字符处理：退止单独处理(\b\x1b[K)，其他正常回显
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (ch === '\x7f' || ch === '\x08') {
        // 钳制：输入行已空时不回退（真实路由器不让删过提示符 router>）
        if (lineBuf.length === 0) continue
        lineBuf = lineBuf.slice(0, -1)
        socket.write('\b\x1b[K')
        continue
      }
      socket.write(ch.replace(/\r(?!\n)/g, '\r\n'))
      lineBuf += ch
    }
    let nl
    while ((nl = lineBuf.search(/[\r\n]/)) >= 0) {
      const line = lineBuf.slice(0, nl)
      lineBuf = lineBuf.slice(nl + 1).replace(/^\n/, '')
      const out = respond(line)
      socket.write(out)
      if (out.includes('connection closed')) { socket.end(); return }
    }
  })
  socket.on('error', () => { /* 客户端断开 */ })
})

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port
  console.log(`[mock-device] ${LABEL} 已启动，监听 127.0.0.1:${actual}`)
  console.log(`[mock-device] 在终端管理插件里新建 Telnet 连接：主机 127.0.0.1 端口 ${actual}`)
})

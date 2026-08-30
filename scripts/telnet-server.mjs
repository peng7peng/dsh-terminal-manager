#!/usr/bin/env node
/**
 * 简单的 Telnet 服务器 - 用于本地测试
 * 用法: node scripts/telnet-server.mjs [端口]
 * 默认端口: 2323
 */

import * as net from 'node:net'

const PORT = Number(process.argv[2] ?? 2323)

// Telnet 协议常量
const IAC = 0xff
const WILL = 0xfb
const WONT = 0xfc
const DO = 0xfd
const DONT = 0xfe
const ECHO = 1
const SGA = 3  // Suppress Go Ahead

const server = net.createServer((socket) => {
  const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`
  console.log(`[+] 新连接: ${remoteAddress}`)

  // 发送 Telnet 协商：要求字符模式
  // IAC WILL ECHO - 服务器回显
  // IAC WILL SGA - 抑制 Go Ahead
  // IAC DO SGA - 请求客户端也抑制 Go Ahead
  socket.write(Buffer.from([
    IAC, WILL, ECHO,
    IAC, WILL, SGA,
    IAC, DO, SGA
  ]))

  // 发送欢迎信息
  socket.write('\r\n=== Telnet 测试服务器 ===\r\n')
  socket.write(`端口: ${PORT}\r\n`)
  socket.write('输入 help 查看可用命令\r\n')
  socket.write('输入 exit 断开连接\r\n\r\n')
  socket.write('> ')

  let buffer = ''

  socket.on('data', (data) => {
    // 处理 Telnet 命令（简单过滤）
    const cleanData = []
    let i = 0
    while (i < data.length) {
      if (data[i] === IAC && i + 2 < data.length) {
        // 跳过 IAC 命令（3字节）
        i += 3
      } else if (data[i] === 0x0d && i + 1 < data.length && data[i + 1] === 0x0a) {
        // CRLF -> 只处理一次
        cleanData.push(0x0d)
        i += 2
      } else {
        cleanData.push(data[i])
        i++
      }
    }

    const text = Buffer.from(cleanData).toString('utf8')

    for (const char of text) {
      if (char === '\r' || char === '\n') {
        if (buffer.trim().length > 0) {
          handleCommand(socket, buffer.trim())
        }
        buffer = ''
        socket.write('\r\n> ')
      } else if (char === '\x7f' || char === '\x08') {
        // Backspace
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1)
          socket.write('\x08 \x08') // 回退、空格、回退
        }
      } else {
        buffer += char
        socket.write(char) // 回显
      }
    }
  })

  socket.on('close', () => {
    console.log(`[-] 连接关闭: ${remoteAddress}`)
  })

  socket.on('error', (err) => {
    console.error(`[!] 错误 ${remoteAddress}: ${err.message}`)
  })
})

function handleCommand(socket, cmd) {
  socket.write('\r\n')
  const lowerCmd = cmd.toLowerCase()

  if (lowerCmd === 'help') {
    socket.write('可用命令:\r\n')
    socket.write('  help    - 显示此帮助\r\n')
    socket.write('  status  - 显示服务器状态\r\n')
    socket.write('  time    - 显示当前时间\r\n')
    socket.write('  echo    - 回显你输入的内容\r\n')
    socket.write('  exit    - 断开连接\r\n')
  } else if (lowerCmd === 'status') {
    socket.write('服务器运行中\r\n')
    socket.write(`端口: ${PORT}\r\n`)
    socket.write(`连接数: ${server.getConnections ? 'N/A' : 'unknown'}\r\n`)
  } else if (lowerCmd === 'time') {
    socket.write(`当前时间: ${new Date().toLocaleString()}\r\n`)
  } else if (lowerCmd.startsWith('echo ')) {
    socket.write(`你说的是: ${cmd.slice(5)}\r\n`)
  } else if (lowerCmd === 'exit' || lowerCmd === 'quit') {
    socket.write('再见!\r\n')
    socket.end()
  } else {
    socket.write(`未知命令: ${cmd}\r\n`)
    socket.write('输入 help 查看可用命令\r\n')
  }
}

server.listen(PORT, () => {
  console.log(`[Telnet] 服务器启动在端口 ${PORT}`)
  console.log(`[Telnet] 连接: telnet localhost ${PORT}`)
  console.log('[Telnet] 按 Ctrl+C 停止')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT} 已被占用`)
  } else {
    console.error(`[!] 服务器错误: ${err.message}`)
  }
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('\n[Telnet] 正在关闭...')
  server.close(() => {
    console.log('[Telnet] 已关闭')
    process.exit(0)
  })
})

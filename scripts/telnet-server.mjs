#!/usr/bin/env node
/**
 * 模拟真实 telnetd 的 Telnet 服务器（带登录）
 *
 * 用法: node scripts/telnet-server.mjs [端口] [用户名] [密码]
 * 默认: 端口 2323, 用户名 admin, 密码 admin123
 */

import * as net from 'node:net'

const PORT = Number(process.argv[2] ?? 2323)
const VALID_USER = process.argv[3] ?? 'admin'
const VALID_PASS = process.argv[4] ?? 'admin123'

// Telnet 协议常量
const IAC = 0xff
const WILL = 0xfb
const WONT = 0xfc
const DO = 0xfd
const DONT = 0xfe
const SB = 0xfa
const SE = 0xf0
const ECHO = 1
const SGA = 3
const TTYPE = 24

const server = net.createServer((socket) => {
  const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`
  console.log(`[+] 新连接: ${remoteAddress}`)

  // 状态机
  let phase = 'negotiation' // negotiation -> username -> password -> shell
  let negotiationComplete = false
  let responseCount = 0
  let iacState = 'data'
  let iacCmd = 0
  let localEcho = true // 本地回显控制
  let buffer = ''
  let username = ''
  let loginAttempts = 0

  // 发送初始协商
  socket.write(Buffer.from([
    IAC, WILL, ECHO,
    IAC, WILL, SGA,
    IAC, DO, SGA,
    IAC, DO, TTYPE,
  ]))

  console.log(`[i] 等待协商... (有效账号: ${VALID_USER}/${VALID_PASS})`)

  const negotiationTimeout = setTimeout(() => {
    if (phase === 'negotiation') {
      console.log(`[!] 协商超时，继续`)
      negotiationComplete = true
      promptUsername()
    }
  }, 5000)

  function promptUsername() {
    phase = 'username'
    localEcho = true
    socket.write('\r\n')
    socket.write('Ubuntu 20.04.5 LTS\r\n')
    socket.write('\r\n')
    socket.write('telnet-server login: ')
    buffer = ''
  }

  function promptPassword() {
    phase = 'password'
    localEcho = false // 密码不回显
    // 发送 WONT ECHO 关闭回显
    socket.write(Buffer.from([IAC, WONT, ECHO]))
    socket.write('Password: ')
    buffer = ''
  }

  function enterShell() {
    phase = 'shell'
    localEcho = true
    // 发送 WILL ECHO 重新开启回显
    socket.write(Buffer.from([IAC, WILL, ECHO]))
    socket.write('\r\n')
    socket.write('Welcome to Telnet Server!\r\n')
    socket.write(`Last login: ${new Date().toLocaleString()} from ${socket.remoteAddress}\r\n`)
    socket.write('\r\n')
    showPrompt()
  }

  function showPrompt() {
    socket.write(`${username}@telnet:~$ `)
    buffer = ''
  }

  function cmdToString(cmd) {
    return { [WILL]: 'WILL', [WONT]: 'WONT', [DO]: 'DO', [DONT]: 'DONT' }[cmd] || `CMD(${cmd})`
  }

  function optionToString(opt) {
    return { [ECHO]: 'ECHO', [SGA]: 'SGA', [TTYPE]: 'TTYPE' }[opt] || `OPT(${opt})`
  }

  socket.on('data', (data) => {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i]

      switch (iacState) {
        case 'data':
          if (byte === IAC) {
            iacState = 'iac'
          } else if (phase !== 'negotiation') {
            const char = String.fromCharCode(byte)
            if (char === '\r' || char === '\n') {
              handleLine(socket)
            } else if (char === '\x7f' || char === '\x08') {
              // Backspace
              if (buffer.length > 0) {
                buffer = buffer.slice(0, -1)
                if (localEcho) socket.write('\x08 \x08')
              }
            } else if (byte >= 32 && byte < 127) {
              buffer += char
              if (localEcho) socket.write(char)
            }
          }
          break

        case 'iac':
          if (byte === IAC) {
            iacState = 'data'
          } else if (byte === SB) {
            iacState = 'sb'
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            iacCmd = byte
            iacState = 'cmd'
          } else {
            iacState = 'data'
          }
          break

        case 'cmd':
          console.log(`[<] ${cmdToString(iacCmd)} ${optionToString(byte)}`)
          responseCount++
          if (responseCount >= 2 && phase === 'negotiation') {
            clearTimeout(negotiationTimeout)
            console.log(`[✓] 协商完成`)
            negotiationComplete = true
            promptUsername()
          }
          iacState = 'data'
          break

        case 'sb':
          iacState = 'sb-data'
          break

        case 'sb-data':
          if (byte === IAC) {
            iacState = 'sb-iac'
          }
          break

        case 'sb-iac':
          if (byte === SE) {
            iacState = 'data'
          } else if (byte !== IAC) {
            iacState = 'sb-data'
          }
          break
      }
    }
  })

  function handleLine(socket) {
    const line = buffer.trim()
    buffer = ''

    switch (phase) {
      case 'username':
        if (line.length === 0) {
          socket.write('\r\ntelnet-server login: ')
          return
        }
        username = line
        console.log(`[i] 用户名: ${username}`)
        socket.write('\r\n')
        promptPassword()
        break

      case 'password':
        console.log(`[i] 密码: ${'*'.repeat(line.length)}`)
        socket.write('\r\n')
        if (username === VALID_USER && line === VALID_PASS) {
          console.log(`[✓] 登录成功: ${username}`)
          enterShell()
        } else {
          loginAttempts++
          console.log(`[✗] 登录失败 (${loginAttempts}/3)`)
          if (loginAttempts >= 3) {
            socket.write('Login incorrect\r\n')
            socket.write('Too many login failures\r\n')
            socket.end()
            return
          }
          socket.write('Login incorrect\r\n')
          promptUsername()
        }
        break

      case 'shell':
        socket.write('\r\n')
        if (line === 'exit' || line === 'logout') {
          socket.write('logout\r\n')
          socket.end()
          return
        } else if (line === 'help') {
          socket.write('可用命令: help, whoami, date, exit\r\n')
        } else if (line === 'whoami') {
          socket.write(`${username}\r\n`)
        } else if (line === 'date') {
          socket.write(`${new Date().toLocaleString()}\r\n`)
        } else if (line === '') {
          // 空行
        } else {
          socket.write(`bash: ${line}: 命令找不到\r\n`)
        }
        showPrompt()
        break
    }
  }

  socket.on('close', () => {
    clearTimeout(negotiationTimeout)
    console.log(`[-] 连接关闭: ${remoteAddress}`)
  })

  socket.on('error', (err) => {
    console.error(`[!] 错误: ${err.message}`)
  })
})

server.listen(PORT, () => {
  console.log(`[Telnet] 服务器启动在端口 ${PORT}`)
  console.log(`[Telnet] 账号: ${VALID_USER} / 密码: ${VALID_PASS}`)
  console.log('[Telnet] 按 Ctrl+C 停止')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT} 已被占用`)
  } else {
    console.error(`[!] 错误: ${err.message}`)
  }
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('\n[Telnet] 正在关闭...')
  server.close(() => process.exit(0))
})

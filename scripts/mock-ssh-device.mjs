#!/usr/bin/env node
/**
 * 本地模拟 SSH 设备——给终端管理插件活测 SSH 连接 / 文件传输用，无需真实 SSH 服务器。
 *
 * 用法：node scripts/mock-ssh-device.mjs [端口] [密码] [SFTP 根目录]
 *   默认端口 2222，密码 test-pass，SFTP 根 = 系统临时目录下 mock-ssh-device-files。
 *
 * 认证：用户名 admin + 密码（默认 test-pass），或任意密钥（都接受）。
 * 行为：连上发横幅 + prompt；支持 show version / show interface / ping / echo / help / exit；
 *       sftp 子系统把远端路径映射到本地根目录（上传 / 下载 / 列目录，供远端文件面板活测）。
 * 注意：这是本地测试设备——任意公钥都放行、密码明文在命令行参数里，别用真实密码；
 *       SFTP 根有越界围栏（`..` 逃不出去），但根目录本身仍以运行者权限可读写。
 *
 * 在插件界面：新建 SSH 连接，主机 127.0.0.1、端口 2222、用户名 admin、密码 test-pass。
 */
import { generateKeyPairSync } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'

// ssh2 是 CJS，动态 import 拿 default
const ssh2mod = await import('ssh2')
const ssh2 = ssh2mod.default ?? ssh2mod
const Server = ssh2.Server
const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp

const PORT = Number(process.argv[2] ?? 2222)
const PASSWORD = process.argv[3] ?? 'test-pass'
const SFTP_ROOT = process.argv[4] ?? join(tmpdir(), 'mock-ssh-device-files')
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
  return `\r\n\x1b[36m${'='.repeat(40)}\r\n${LABEL}\r\nSoftware: MockSSHOS 2.0\r\nUp: ${new Date().toLocaleString()}\r\n${'='.repeat(40)}\x1b[0m\r\n\r\nType 'help' for commands.\r\n\r\n\x1b[32mssh>\x1b[0m `
}

function respond(cmd) {
  const c = cmd.trim()
  if (c === '') return '\x1b[32mssh>\x1b[0m '
  if (c === 'help' || c === '?') return HELP + '\r\n\x1b[32mssh>\x1b[0m '
  if (c === 'show version') {
    return `MockSSHOS Version 2.0.1\r\nCompiled ${new Date().toISOString().slice(0, 10)}\r\n uptime 5 days\r\n\x1b[32mssh>\x1b[0m `
  }
  if (c === 'show interface') {
    return `Interface              Status\r\nEth0                   up\r\nEth1                   up\r\n\x1b[32mssh>\x1b[0m `
  }
  if (c.startsWith('ping ')) {
    const host = c.slice(5)
    const lines = ['Type escape sequence to abort.']
    for (let i = 0; i < 4; i++) lines.push(`!!!!! from ${host}: seq=${i} ttl=64 time=1.${i}ms`)
    lines.push('Success rate is 100% (4/4)')
    return lines.join('\r\n') + '\r\n\x1b[32mssh>\x1b[0m '
  }
  if (c.startsWith('echo ')) return c.slice(5) + '\r\n\x1b[32mssh>\x1b[0m '
  if (c === 'exit' || c === 'quit') return '\r\n\x1b[31m[connection closed]\x1b[0m\r\n'
  return `\x1b[31m% Unknown command: "${c}"\x1b[0m\r\n\x1b[32mssh>\x1b[0m `
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
          const str = data.toString('utf8')
          for (let i = 0; i < str.length; i++) {
            const ch = str[i]
            if (ch === '\x7f' || ch === '\x08') {
              // 钳制：输入行已空时不回退（真实设备不让删过提示符 ssh>）
              if (lineBuf.length === 0) continue
              lineBuf = lineBuf.slice(0, -1)
              stream.write('\b\x1b[K')
              continue
            }
            stream.write(ch.replace(/\r(?!\n)/g, '\r\n'))
            lineBuf += ch
          }
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
      // sftp 子系统：远端路径映射到 SFTP_ROOT（插件远端文件面板 / 文件传输活测用）
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        const fds = new Map()
        const dirs = new Map()
        let seq = 0

        // '/up/x' → SFTP_ROOT/up/x（Windows 上 resolve 同时吃正反斜杠）。
        // 越界围栏（审查 2026-09-03）：resolve 会折叠 ..，`/../../..` 能逃出根——
        // 逃出根的路径一律返回 undefined，由各操作回 PERMISSION_DENIED。
        const rootAbs = resolvePath(SFTP_ROOT)
        const toLocal = (p) => {
          const abs = resolvePath(SFTP_ROOT, `.${p.startsWith('/') ? p : `/${p}`}`)
          if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return undefined
          return abs
        }
        const statusOf = (err) => {
          const code = err?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE
          if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED
          return STATUS_CODE.FAILURE
        }
        const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atime, mtime: st.mtime })
        const fail = (reqid, err) => { sftp.status(reqid, statusOf(err), err?.message) }
        const outside = (reqid) => { sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, '路径越出 SFTP 根目录') }

        sftp.on('OPEN', (reqid, filename, flags) => {
          const lp = toLocal(filename)
          if (lp === undefined) { outside(reqid); return }
          let fsFlags = 'r'
          if (flags & OPEN_MODE.WRITE) {
            if (flags & OPEN_MODE.APPEND) fsFlags = 'a'
            else if (flags & (OPEN_MODE.TRUNC | OPEN_MODE.CREAT)) fsFlags = 'w'
            else fsFlags = 'r+'
          }
          fsp.open(lp, fsFlags)
            .then((handle) => {
              const key = `h${++seq}`
              fds.set(key, handle)
              sftp.handle(reqid, Buffer.from(key))
            })
            .catch((err) => fail(reqid, err))
        })
        sftp.on('READ', (reqid, handle, filePos, len) => {
          const h = fds.get(handle.toString())
          if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
          const buf = Buffer.alloc(len)
          h.read(buf, 0, len, filePos)
            .then(({ bytesRead }) => sftp.data(reqid, buf.subarray(0, bytesRead)))
            .catch((err) => fail(reqid, err))
        })
        sftp.on('WRITE', (reqid, handle, filePos, data) => {
          const h = fds.get(handle.toString())
          if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
          h.write(data, 0, data.length, filePos)
            .then(() => sftp.status(reqid, STATUS_CODE.OK))
            .catch((err) => fail(reqid, err))
        })
        sftp.on('CLOSE', (reqid, handle) => {
          const key = handle.toString()
          const file = fds.get(key)
          const isDir = dirs.has(key)
          fds.delete(key)
          dirs.delete(key)
          if (file !== undefined) {
            file.close()
              .then(() => sftp.status(reqid, STATUS_CODE.OK))
              .catch(() => sftp.status(reqid, STATUS_CODE.OK))
          } else if (isDir) {
            // 目录句柄：entries 在内存里，无需真正关闭（客户端 readdir 收完 EOF 会 close）
            sftp.status(reqid, STATUS_CODE.OK)
          } else {
            sftp.status(reqid, STATUS_CODE.FAILURE)
          }
        })
        sftp.on('OPENDIR', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.readdir(lp, { withFileTypes: true })
            .then((entries) => {
              const key = `h${++seq}`
              dirs.set(key, { entries, idx: 0, dir: lp })
              sftp.handle(reqid, Buffer.from(key))
            })
            .catch((err) => fail(reqid, err))
        })
        sftp.on('READDIR', (reqid, handle) => {
          const d = dirs.get(handle.toString())
          if (!d) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
          if (d.idx >= d.entries.length) { sftp.status(reqid, STATUS_CODE.EOF); return }
          const batch = d.entries.slice(d.idx, d.idx + 50)
          d.idx += batch.length
          Promise.all(batch.map(async (e) => {
            const st = await fsp.lstat(join(d.dir, e.name)).catch(() => undefined)
            return {
              filename: e.name,
              longname: `${e.isDirectory() ? 'd' : '-'}rw-r--r--  1 owner group ${st ? String(st.size).padStart(8) : '       -'} Jan  1 00:00 ${e.name}`,
              ...(st ? { attrs: attrsOf(st) } : {}),
            }
          }))
            .then((items) => sftp.name(reqid, items))
            .catch(() => sftp.status(reqid, STATUS_CODE.FAILURE))
        })
        sftp.on('STAT', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.stat(lp).then((st) => sftp.attrs(reqid, attrsOf(st))).catch((err) => fail(reqid, err))
        })
        sftp.on('LSTAT', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.lstat(lp).then((st) => sftp.attrs(reqid, attrsOf(st))).catch((err) => fail(reqid, err))
        })
        sftp.on('FSTAT', (reqid, handle) => {
          const h = fds.get(handle.toString())
          if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
          h.stat().then((st) => sftp.attrs(reqid, attrsOf(st))).catch((err) => fail(reqid, err))
        })
        sftp.on('MKDIR', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.mkdir(lp).then(() => sftp.status(reqid, STATUS_CODE.OK)).catch((err) => fail(reqid, err))
        })
        sftp.on('RMDIR', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.rmdir(lp).then(() => sftp.status(reqid, STATUS_CODE.OK)).catch((err) => fail(reqid, err))
        })
        sftp.on('REMOVE', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          fsp.unlink(lp).then(() => sftp.status(reqid, STATUS_CODE.OK)).catch((err) => fail(reqid, err))
        })
        sftp.on('RENAME', (reqid, from, to) => {
          const lf = toLocal(from)
          const lt = toLocal(to)
          if (lf === undefined || lt === undefined) { outside(reqid); return }
          fsp.rename(lf, lt).then(() => sftp.status(reqid, STATUS_CODE.OK)).catch((err) => fail(reqid, err))
        })
        sftp.on('REALPATH', (reqid, p) => {
          const lp = toLocal(p)
          if (lp === undefined) { outside(reqid); return }
          sftp.name(reqid, [{ filename: lp }])
        })
        sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
        sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
      })
    })
  })
  client.on('error', () => { /* 客户端断开 */ })
})

server.listen(PORT, '127.0.0.1', async () => {
  const actual = server.address().port
  await fsp.mkdir(SFTP_ROOT, { recursive: true }).catch(() => {})
  console.log(`[mock-ssh-device] ${LABEL} 已启动，监听 127.0.0.1:${actual}`)
  console.log(`[mock-ssh-device] 在插件里新建 SSH 连接：主机 127.0.0.1 端口 ${actual} 用户名 admin 密码 ${PASSWORD}`)
  console.log(`[mock-ssh-device] SFTP 根目录（面板远端 / 即这里）：${SFTP_ROOT}`)
})

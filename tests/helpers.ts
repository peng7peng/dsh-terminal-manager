/**
 * 测试用模拟设备工厂：进程内起"假设备"，集成测试不依赖真实设备。
 */
import { generateKeyPairSync } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import type { Dirent, FileHandle, Stats as FsStats } from 'node:fs'
import { createServer, type Server as NetServer } from 'node:net'
import * as nodePath from 'node:path'
import { Server as SshServer, utils } from 'ssh2'

// 测试用主机密钥（EC P-256）
export const HOST_KEY = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

/** 输出收集器：把 onData 的碎片攒起来，可等待子串出现。 */
export function collector() {
  let buffer = ''
  const waiters: Array<{ needle: string; resolve: () => void }> = []
  return {
    onData: (chunk: string) => {
      buffer += chunk
      for (const w of [...waiters]) {
        if (buffer.includes(w.needle)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve()
        }
      }
    },
    waitFor: (needle: string, timeoutMs = 5000): Promise<void> => {
      if (buffer.includes(needle)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 "${needle}" 超时，已收到: ${JSON.stringify(buffer)}`)), timeoutMs)
        waiters.push({ needle, resolve: () => { clearTimeout(timer); resolve() } })
      })
    },
    text: () => buffer,
  }
}

/**
 * ssh2 服务端 SFTP 流的应答面（@types/ssh2 未覆盖服务端事件，测试桩自用）。
 * 事件名 / 参数顺序按 ssh2/lib/protocol/SFTP.js 的 server 分支核对（2026-09）。
 */
interface SftpServerStream {
  on(event: 'OPEN', cb: (reqid: number, filename: string, flags: number, attrs: unknown) => void): void
  on(event: 'READ', cb: (reqid: number, handle: Buffer, offset: number, len: number) => void): void
  on(event: 'WRITE', cb: (reqid: number, handle: Buffer, offset: number, data: Buffer) => void): void
  on(event: 'CLOSE' | 'READDIR' | 'FSTAT', cb: (reqid: number, handle: Buffer) => void): void
  on(event: 'OPENDIR' | 'STAT' | 'LSTAT' | 'REMOVE' | 'RMDIR' | 'REALPATH', cb: (reqid: number, p: string) => void): void
  on(event: 'MKDIR', cb: (reqid: number, p: string, attrs: unknown) => void): void
  on(event: 'RENAME', cb: (reqid: number, from: string, to: string) => void): void
  on(event: 'SETSTAT' | 'FSETSTAT', cb: (reqid: number) => void): void
  status(reqid: number, code: number, message?: string): void
  handle(reqid: number, handle: Buffer): void
  data(reqid: number, data: Buffer): void
  name(reqid: number, names: Array<{ filename: string; longname?: string; attrs?: Record<string, unknown> }>): void
  attrs(reqid: number, attrs: Record<string, unknown>): void
}

/** 设备实验室：统一登记清理。 */
export function createDeviceLab() {
  const cleanups: Array<() => Promise<void>> = []

  return {
    /** TCP echo 设备：原样回显收到的字节。可选 iac=true 在连接时发 IAC WILL ECHO + DO TERMINAL_TYPE。 */
    startEchoServer(opts?: { iac?: boolean }): Promise<{ port: number }> {
      return new Promise((resolve) => {
        const server: NetServer = createServer((socket) => {
          if (opts?.iac === true) {
            socket.write(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfd, 0x18]))
          }
          socket.on('error', () => {})
          socket.pipe(socket)
        })
        cleanups.push(() => new Promise<void>((done) => {
          server.closeAllConnections?.()
          server.close(() => done())
        }))
        server.listen(0, '127.0.0.1', () => {
          resolve({ port: (server.address() as { port: number }).port })
        })
      })
    },

    /** SSH 设备：横幅 + 回显；密码 admin/test-pass，密钥一律接受。 */
    startSshDevice(): Promise<{ port: number }> {
      return new Promise((resolve) => {
        const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
          client.on('authentication', (ctx) => {
            if (ctx.method === 'password') {
              return ctx.username === 'admin' && ctx.password === 'test-pass' ? ctx.accept() : ctx.reject()
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
                stream.write('Welcome to test device\r\n')
                stream.on('data', (data: Buffer) => stream.write(data))
              })
            })
          })
        })
        cleanups.push(() => new Promise<void>((done) => {
          server.close(() => done())
        }))
        server.listen(0, '127.0.0.1', () => {
          resolve({ port: (server.address() as { port: number }).port })
        })
      })
    },

    /**
     * SSH 设备（S5 传输测试用）：与 startSshDevice 行为一致，另支持 sftp 子系统。
     * 这里只完成 SFTP 握手（接受通道、应答 INIT）；具体文件操作由 tests/sftp.spec.ts 自带更完整的内存实现。
     */
    startSshDeviceWithSftp(): Promise<{ port: number }> {
      return new Promise((resolve) => {
        const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
          client.on('authentication', (ctx) => {
            if (ctx.method === 'password') {
              return ctx.username === 'admin' && ctx.password === 'test-pass' ? ctx.accept() : ctx.reject()
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
                stream.write('Welcome to test device\r\n')
                stream.on('data', (data: Buffer) => stream.write(data))
              })
              session.on('sftp', (acceptSftp) => acceptSftp())
            })
          })
        })
        cleanups.push(() => new Promise<void>((done) => {
          server.close(() => done())
        }))
        server.listen(0, '127.0.0.1', () => {
          resolve({ port: (server.address() as { port: number }).port })
        })
      })
    },

    /**
     * SSH + SFTP 设备（S5 传输 / 文件服务测试用）：sftp 子系统直接读写本机 rootDir（后端 = 真实文件系统）。
     * SFTP 路径统一 POSIX 风格：'/' 映射到 rootDir 本身，其余逐段拼到 rootDir 下；
     * shell 行为与 startSshDevice 相同（横幅 + 回显）。
     */
    startSftpDevice(rootDir: string): Promise<{ port: number }> {
      return new Promise((resolve) => {
        const { STATUS_CODE, OPEN_MODE } = utils.sftp
        const fds = new Map<string, FileHandle>()
        const dirs = new Map<string, { entries: Dirent[]; idx: number; dir: string }>()
        let seq = 0

        // '/up/x' → rootDir/up/x（Windows 上 path.resolve 同时吃正反斜杠）
        const toLocal = (p: string): string => nodePath.resolve(rootDir, `.${p.startsWith('/') ? p : `/${p}`}`)
        const statusOf = (err: NodeJS.ErrnoException | undefined): number => {
          const code = err?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE
          if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED
          return STATUS_CODE.FAILURE
        }
        const attrsOf = (st: FsStats): Record<string, unknown> => ({
          mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atime, mtime: st.mtime,
        })
        const fail = (sftp: SftpServerStream, reqid: number, err: NodeJS.ErrnoException | undefined): void => {
          sftp.status(reqid, statusOf(err), err?.message)
        }

        const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
          client.on('authentication', (ctx) => {
            if (ctx.method === 'password') {
              return ctx.username === 'admin' && ctx.password === 'test-pass' ? ctx.accept() : ctx.reject()
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
                stream.write('Welcome to test device\r\n')
                stream.on('data', (data: Buffer) => stream.write(data))
              })
              session.on('sftp', (acceptSftp) => {
                const sftp = acceptSftp() as unknown as SftpServerStream

                sftp.on('OPEN', (reqid, filename, flags) => {
                  let fsFlags = 'r'
                  if (flags & OPEN_MODE.WRITE) {
                    if (flags & OPEN_MODE.APPEND) fsFlags = 'a'
                    else if (flags & (OPEN_MODE.TRUNC | OPEN_MODE.CREAT)) fsFlags = 'w'
                    else fsFlags = 'r+'
                  }
                  fsp.open(toLocal(filename), fsFlags)
                    .then((handle) => {
                      const key = `h${++seq}`
                      fds.set(key, handle)
                      sftp.handle(reqid, Buffer.from(key))
                    })
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })

                sftp.on('READ', (reqid, handle, filePos, len) => {
                  const h = fds.get(handle.toString())
                  if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
                  const buf = Buffer.alloc(len)
                  h.read(buf, 0, len, filePos)
                    .then(({ bytesRead }) => sftp.data(reqid, buf.subarray(0, bytesRead)))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })

                sftp.on('WRITE', (reqid, handle, filePos, data) => {
                  const h = fds.get(handle.toString())
                  if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
                  h.write(data, 0, data.length, filePos)
                    .then(() => sftp.status(reqid, STATUS_CODE.OK))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
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
                    // 目录句柄：entries 已在内存里，无需真正关闭（ssh2 客户端 readdir 收完 EOF 会 close 目录句柄）
                    sftp.status(reqid, STATUS_CODE.OK)
                  } else {
                    sftp.status(reqid, STATUS_CODE.FAILURE)
                  }
                })

                sftp.on('OPENDIR', (reqid, p) => {
                  const dir = toLocal(p)
                  fsp.readdir(dir, { withFileTypes: true })
                    .then((entries) => {
                      const key = `h${++seq}`
                      dirs.set(key, { entries, idx: 0, dir })
                      sftp.handle(reqid, Buffer.from(key))
                    })
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })

                sftp.on('READDIR', (reqid, handle) => {
                  const d = dirs.get(handle.toString())
                  if (!d) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
                  if (d.idx >= d.entries.length) { sftp.status(reqid, STATUS_CODE.EOF); return }
                  const batch = d.entries.slice(d.idx, d.idx + 50)
                  d.idx += batch.length
                  Promise.all(batch.map(async (e) => {
                    const st = await fsp.lstat(nodePath.join(d.dir, e.name)).catch(() => undefined)
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
                  fsp.stat(toLocal(p))
                    .then((st) => sftp.attrs(reqid, attrsOf(st)))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('LSTAT', (reqid, p) => {
                  fsp.lstat(toLocal(p))
                    .then((st) => sftp.attrs(reqid, attrsOf(st)))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('FSTAT', (reqid, handle) => {
                  const h = fds.get(handle.toString())
                  if (h === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return }
                  h.stat()
                    .then((st) => sftp.attrs(reqid, attrsOf(st)))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })

                sftp.on('MKDIR', (reqid, p) => {
                  fsp.mkdir(toLocal(p))
                    .then(() => sftp.status(reqid, STATUS_CODE.OK))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('RMDIR', (reqid, p) => {
                  fsp.rmdir(toLocal(p))
                    .then(() => sftp.status(reqid, STATUS_CODE.OK))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('REMOVE', (reqid, p) => {
                  fsp.unlink(toLocal(p))
                    .then(() => sftp.status(reqid, STATUS_CODE.OK))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('RENAME', (reqid, from, to) => {
                  fsp.rename(toLocal(from), toLocal(to))
                    .then(() => sftp.status(reqid, STATUS_CODE.OK))
                    .catch((err: NodeJS.ErrnoException) => fail(sftp, reqid, err))
                })
                sftp.on('REALPATH', (reqid, p) => {
                  sftp.name(reqid, [{ filename: toLocal(p) }])
                })
                sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
                sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
              })
            })
          })
        })
        cleanups.push(() => new Promise<void>((done) => {
          server.close(() => done())
        }))
        server.listen(0, '127.0.0.1', () => {
          resolve({ port: (server.address() as { port: number }).port })
        })
      })
    },

    async cleanup(): Promise<void> {
      while (cleanups.length > 0) {
        await cleanups.pop()!()
      }
    },
  }
}

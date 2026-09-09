#!/usr/bin/env node
/**
 * E2E 一键自动化测试：自动拉起 mock 设备 + DSH tm-dev 服务，跑全部场景并落盘结果。
 *
 * 用法：
 *   node scripts/run-e2e.mjs
 *
 * 前置条件：
 *   - pnpm build 已执行（DSH 从 lib/index.js 加载）
 *   - ../deepseek-harness 存在且已 pnpm install
 *   - 端口 2323/2324/2222/4480 未被占用
 *
 * 退出码：0=全过，1=有失败
 */
import { spawn, execSync } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { createSocket } from 'node:dgram'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DSH_HARNESS = join(PROJECT_ROOT, '..', 'deepseek-harness')
const RESULTS_DIR = join(PROJECT_ROOT, '..', '.codeartswork', 'tests', 'dsh-terminal-manager')

const DSH_PORT = Number(process.env.DSH_PORT ?? 4480)
const DSH_PROFILE = process.env.DSH_PROFILE ?? 'tm-dev'
const SKIP_BUILD = process.env.SKIP_BUILD === '1'
const DSH_ORIGIN = `http://127.0.0.1:${DSH_PORT}`

// ─── 进程管理 ──────────────────────────────────────────────

const children = []
let cleaned = false

function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const child of children) {
    try {
      if (!child.killed) {
        // Windows shell 模式下 spawn 的 PID 是 cmd.exe，需要 taskkill /T 杀整个进程树
        if (process.platform === 'win32') {
          try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }) } catch {}
        } else {
          child.kill('SIGTERM')
        }
      }
    } catch {}
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

function startProcess(cmd, args, opts = {}) {
  // Windows 上 pnpm 等命令是 .cmd 包装，需要 shell 模式才能找到
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...opts })
  children.push(child)
  child.stdout?.on('data', (d) => process.stdout.write(`[${args.join(' ')}] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[${args.join(' ')}] ${d}`))
  child.on('error', (e) => console.error(`进程启动失败 [${args.join(' ')}]: ${e.message}`))
  return child
}

function waitForOutput(child, needle, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 "${needle}" 超时`)), timeoutMs)
    const onData = (d) => {
      if (d.toString().includes(needle)) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
  })
}

// ─── 辅助工具 ──────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tcpEchoServer() {
  const server = createServer((socket) => socket.pipe(socket))
  await new Promise((r, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', r) })
  return { server, port: server.address().port }
}

async function udpEchoServer() {
  const socket = createSocket('udp4')
  socket.on('message', (msg, rinfo) => socket.send(msg, rinfo.port, rinfo.address))
  await new Promise((r, rej) => { socket.once('error', rej); socket.bind(0, '127.0.0.1', r) })
  return { socket, port: socket.address().port }
}

async function freeTcpPort() {
  const { server, port } = await tcpEchoServer()
  await new Promise((r) => server.close(r))
  return port
}

async function tcpRoundTrip(port, data) {
  const socket = createConnection({ port, host: '127.0.0.1' })
  await new Promise((r, rej) => { socket.once('connect', r); socket.once('error', rej) })
  const reply = new Promise((r, rej) => { socket.once('data', r); socket.once('error', rej) })
  socket.write(data)
  const buf = await reply
  socket.destroy()
  return buf.toString()
}

async function udpRoundTrip(port, data) {
  const socket = createSocket('udp4')
  const reply = new Promise((r, rej) => { socket.once('message', r); socket.once('error', rej) })
  await new Promise((r, rej) => socket.send(Buffer.from(data), port, '127.0.0.1', (e) => e ? rej(e) : r()))
  const buf = await reply
  await new Promise((r) => socket.close(r))
  return buf.toString()
}

// ─── RPC ───────────────────────────────────────────────────

async function rpc(method, payload = {}) {
  const res = await fetch(`${DSH_ORIGIN}/term-manager/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body.result
}

async function portLogRpc(method, payload = {}) {
  const res = await fetch(`${DSH_ORIGIN}/term-manager/ext/port-log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body.result
}

// ─── 测试运行器 ─────────────────────────────────────────────

const results = []
const cleanups = []

async function test(id, name, fn) {
  const start = Date.now()
  try {
    await fn()
    results.push({ id, name, status: 'pass', duration: Date.now() - start })
    console.log(`  ✅ ${name}`)
  } catch (e) {
    results.push({ id, name, status: 'fail', error: e.message, duration: Date.now() - start })
    console.log(`  ❌ ${name}: ${e.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

// ─── 设备地址常量 ───────────────────────────────────────────

const DEV_A = { protocol: 'telnet', host: '127.0.0.1', port: 2323, label: 'A' }
const DEV_B = { protocol: 'telnet', host: '127.0.0.1', port: 2324, label: 'B' }
const SSH_DEV = { protocol: 'ssh', host: '127.0.0.1', port: 2222, username: 'admin', password: 'test-pass', label: 'ssh-A' }

async function connect(target) {
  const r = await rpc('sessions.connect', target)
  if (!r.ok) throw new Error(`连接失败: ${r.error.message}`)
  return r.value
}

async function disconnect(sid) {
  await rpc('sessions.disconnect', { sessionId: sid })
}

// ─── 主流程 ─────────────────────────────────────────────────

async function main() {
  const totalStart = Date.now()
  console.log('═'.repeat(60))
  console.log('DSH Terminal Manager — E2E 自动化测试')
  console.log('═'.repeat(60))

  // 1. 构建（CI 可跳过，已在 workflow 里 build 过）
  if (SKIP_BUILD) {
    console.log('\n▶ 跳过构建（SKIP_BUILD=1）')
  } else {
    console.log('\n▶ 构建项目 (pnpm build)')
    const buildChild = startProcess('pnpm', ['build'], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const buildCode = await new Promise((r) => buildChild.on('exit', r))
    if (buildCode !== 0) { console.error('构建失败'); cleanup(); process.exit(1) }
    console.log('  构建完成')
  }

  // 2. 启动 mock 设备
  console.log('\n▶ 启动 mock 设备')
  const dev1 = startProcess('node', ['scripts/mock-device.mjs', '2323'], { cwd: PROJECT_ROOT })
  const dev2 = startProcess('node', ['scripts/mock-device.mjs', '2324'], { cwd: PROJECT_ROOT })
  const sshDev = startProcess('node', ['scripts/mock-ssh-device.mjs', '2222'], { cwd: PROJECT_ROOT })

  try {
    await Promise.all([
      waitForOutput(dev1, '已启动'),
      waitForOutput(dev2, '已启动'),
      waitForOutput(sshDev, '已启动'),
    ])
  } catch (e) {
    console.error(`mock 设备启动失败: ${e.message}`)
    cleanup(); process.exit(1)
  }
  console.log('  mock 设备就绪 (2323/2324/2222)')

  // 3. 启动 DSH tm-dev
  console.log('\n▶ 启动 DSH tm-dev 服务')
  const dsh = startProcess('pnpm', ['dsh', '--profile', DSH_PROFILE, '--port', String(DSH_PORT), '--no-open'], { cwd: DSH_HARNESS })

  // 4. 健康检查
  console.log(`\n▶ 等待 DSH 就绪 (端口 ${DSH_PORT})...`)
  const deadline = Date.now() + 60000
  let dshReady = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DSH_ORIGIN}/term-manager/sessions.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'health', method: 'sessions.list', payload: {} }),
      })
      if (res.ok) { dshReady = true; break }
    } catch {}
    await sleep(500)
  }
  if (!dshReady) { console.error('DSH 健康检查超时'); cleanup(); process.exit(1) }
  console.log('  DSH 就绪')

  // 5. 运行测试场景
  console.log('\n▶ 运行测试场景\n')

  // ─── 既有场景（15 个）───

  // E-CONN-01 临时连接 + 横幅
  await test('E-CONN-01', '临时连接 + 横幅', async () => {
    const r = await rpc('sessions.connect', DEV_A)
    assert(r.ok, '连接成功')
    assert(r.value.status === 'open', 'status=open')
    cleanups.push(() => disconnect(r.value.sessionId))
    // 设备横幅可能需要一点时间到达
    await sleep(500)
    const rd = await rpc('sessions.read', { sessionId: r.value.sessionId })
    assert(rd.ok && rd.value.text.includes('Mock Router'), `read 含 Mock Router（实际: ${rd.ok ? rd.value.text.slice(0, 80) : rd.error.message}）`)
  })

  // E-CONN-02 保存连接 + connId 连
  let savedId
  await test('E-CONN-02', '保存连接 + connId 连', async () => {
    const c = await rpc('connections.create', { label: 'e2', protocol: 'telnet', host: '127.0.0.1', port: 2323 })
    assert(c.ok, '保存成功')
    savedId = c.value.id
    const r = await rpc('sessions.connect', { connId: savedId })
    assert(r.ok && r.value.status === 'open', 'connId 连接 open')
    cleanups.push(() => disconnect(r.value.sessionId))
  })

  // E-CONN-03 编辑连接
  await test('E-CONN-03', '编辑连接', async () => {
    const u = await rpc('connections.update', { id: savedId, patch: { label: 'e2-renamed' } })
    assert(u.ok, '编辑成功')
    const l = await rpc('connections.list')
    assert(l.ok && l.value.some((c) => c.id === savedId && c.label === 'e2-renamed'), 'list 反映新名')
  })

  // E-CONN-04 删除连接
  await test('E-CONN-04', '删除连接', async () => {
    const r = await rpc('connections.remove', { id: savedId })
    assert(r.ok, '删除成功')
    const l = await rpc('connections.list')
    assert(l.ok && !l.value.some((c) => c.id === savedId), 'list 不再含')
  })

  // E-CONN-05 SSH 缺认证 → VALIDATION
  await test('E-CONN-05', 'SSH 缺认证 → VALIDATION', async () => {
    const r = await rpc('connections.create', { label: 'bad', protocol: 'ssh', host: '127.0.0.1', port: 22 })
    assert(!r.ok && r.error.message.includes('VALIDATION'), '返回 VALIDATION')
  })

  // E-CONN-06 地址不通 → HOST_UNREACHABLE
  await test('E-CONN-06', '地址不通 → HOST_UNREACHABLE', async () => {
    const r = await rpc('sessions.connect', { protocol: 'telnet', host: '127.0.0.1', port: 9999 })
    assert(!r.ok && (r.error.message.includes('HOST_UNREACHABLE') || r.error.message.includes('CONN_TIMEOUT')), '返回 HOST_UNREACHABLE/CONN_TIMEOUT')
  })

  // E-CONN-07 断开后操作 → 错误
  await test('E-CONN-07', '断开后操作 → 错误', async () => {
    const s = await connect(DEV_A)
    await disconnect(s.sessionId)
    const r = await rpc('sessions.read', { sessionId: s.sessionId })
    assert(!r.ok && (r.error.message.includes('SESSION_NOT_FOUND') || r.error.message.includes('DISCONNECTED')), '返回 SESSION_NOT_FOUND/DISCONNECTED')
  })

  // E-CONN-08 多设备同屏
  await test('E-CONN-08', '多设备同屏', async () => {
    const a = await connect(DEV_A)
    const b = await connect(DEV_B)
    const l = await rpc('sessions.list')
    assert(l.ok && l.value.filter((s) => s.status === 'open').length >= 2, '2 个 open 会话')
    cleanups.push(() => disconnect(a.sessionId), () => disconnect(b.sessionId))
  })

  // E-SSH-01 SSH 密码连接
  await test('E-SSH-01', 'SSH 密码连接', async () => {
    const r = await rpc('sessions.connect', SSH_DEV)
    assert(r.ok, 'SSH 连接成功')
    assert(r.value.status === 'open', 'status=open')
    await disconnect(r.value.sessionId)
  })

  // E-SSH-02 SSH 密码错误 → AUTH_FAILED
  await test('E-SSH-02', 'SSH 密码错误 → AUTH_FAILED', async () => {
    const r = await rpc('sessions.connect', { ...SSH_DEV, password: 'wrong-pw' })
    assert(!r.ok && r.error.message.includes('AUTH_FAILED'), '返回 AUTH_FAILED')
  })

  // E-SSH-03 SSH 地址不通
  await test('E-SSH-03', 'SSH 地址不通 → HOST_UNREACHABLE', async () => {
    const r = await rpc('sessions.connect', { protocol: 'ssh', host: '127.0.0.1', port: 9998, username: 'a', password: 'b' })
    assert(!r.ok && (r.error.message.includes('HOST_UNREACHABLE') || r.error.message.includes('CONN_TIMEOUT')), '返回 HOST_UNREACHABLE/CONN_TIMEOUT')
  })

  // E-FILE-01 远端文件列表
  let sshSession
  await test('E-FILE-01', '远端文件列表', async () => {
    sshSession = await connect(SSH_DEV)
    cleanups.push(() => disconnect(sshSession.sessionId))
    const r = await rpc('files.remoteTree', { sessionId: sshSession.sessionId, path: '/' })
    assert(r.ok, 'remoteTree 成功')
    assert(Array.isArray(r.value), '返回数组')
  })

  // E-FILE-02 上传下载往返
  await test('E-FILE-02', '上传下载往返', async () => {
    const rootR = await rpc('files.root')
    if (!rootR.ok) { assert(false, 'files.root 失败'); return }
    const root = rootR.value.root
    const content = `e2e-${Date.now()}`
    const w = await rpc('files.write', { root, path: `${root}/e2e-up.txt`, content })
    assert(w.ok, '工作区建源文件')
    const up = await rpc('files.uploadLocal', { sessionId: sshSession.sessionId, remotePath: '/e2e-up.txt', root, path: `${root}/e2e-up.txt`, transferId: 'e2e-up-1' })
    assert(up.ok && up.value.bytes === Buffer.byteLength(content), '上传到设备成功')
    const tree = await rpc('files.remoteTree', { sessionId: sshSession.sessionId, path: '/' })
    assert(tree.ok && tree.value.some((e) => e.name === 'e2e-up.txt'), '设备上出现 e2e-up.txt')
    const dl = await rpc('files.downloadToLocal', { sessionId: sshSession.sessionId, remotePath: '/e2e-up.txt', root, path: `${root}/e2e-dl.txt`, transferId: 'e2e-dl-1' })
    assert(dl.ok && dl.value.bytes === Buffer.byteLength(content), '下载回工作区成功')
    const back = await rpc('files.read', { root, path: `${root}/e2e-dl.txt` })
    assert(back.ok && back.value.content === content, '往返内容一致')
    await rm(`${root}/e2e-up.txt`, { force: true })
    await rm(`${root}/e2e-dl.txt`, { force: true })
  })

  // E-TOOL-01 tm_send 工具层（由单元测试覆盖）
  await test('E-TOOL-01', 'tm_send 工具层（单元测试覆盖）', async () => {
    console.log('    ℹ️ tm_send 是 AI 工具（进程内），由 vitest tools.spec 覆盖')
  })

  // E-GUARD-01 命令守卫拦截（由单元测试覆盖）
  await test('E-GUARD-01', '命令守卫拦截（单元测试覆盖）', async () => {
    console.log('    ℹ️ 命令守卫在 tm_send 工具层，由 vitest tools.spec 覆盖')
  })

  // ─── 新增场景（9 个）───

  // E-PORT-01 TCP 映射端到端
  await test('E-PORT-01', 'TCP 端口映射端到端', async () => {
    const echo = await tcpEchoServer()
    const localPort = await freeTcpPort()
    const mapping = await portLogRpc('mappings.create', {
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: echo.port, autoStart: false,
    })
    assert(mapping.ok, '创建 TCP 映射')
    await portLogRpc('mappings.start', { id: mapping.value.id })
    const reply = await tcpRoundTrip(localPort, 'tcp-e2e')
    assert(reply === 'tcp-e2e', 'TCP 双向转发数据正确')
    await portLogRpc('mappings.stop', { id: mapping.value.id })
    await portLogRpc('mappings.remove', { id: mapping.value.id })
    await new Promise((r) => echo.server.close(r))
  })

  // E-PORT-02 UDP 映射端到端
  await test('E-PORT-02', 'UDP 端口映射端到端', async () => {
    const echo = await udpEchoServer()
    const localPort = await freeTcpPort()
    const mapping = await portLogRpc('mappings.create', {
      protocol: 'udp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: echo.port, autoStart: false,
    })
    assert(mapping.ok, '创建 UDP 映射')
    await portLogRpc('mappings.start', { id: mapping.value.id })
    const reply = await udpRoundTrip(localPort, 'udp-e2e')
    assert(reply === 'udp-e2e', 'UDP 数据报双向转发正确')
    await portLogRpc('mappings.stop', { id: mapping.value.id })
    await portLogRpc('mappings.remove', { id: mapping.value.id })
    await new Promise((r) => echo.socket.close(r))
  })

  // E-PORT-03 端口冲突
  await test('E-PORT-03', '端口冲突 → PORT_IN_USE', async () => {
    const occupied = await tcpEchoServer()
    const localPort = occupied.port
    const mapping = await portLogRpc('mappings.create', {
      protocol: 'tcp', localAddr: '127.0.0.1', localPort,
      redirectAddr: '127.0.0.1', redirectPort: 9999, autoStart: false,
    })
    assert(mapping.ok, '创建映射')
    const startResult = await portLogRpc('mappings.start', { id: mapping.value.id })
    assert(!startResult.ok && startResult.error.code === 'PORT_IN_USE', `预期 PORT_IN_USE，实际 ${startResult.ok ? 'ok' : startResult.error.code}`)
    await portLogRpc('mappings.remove', { id: mapping.value.id })
    await new Promise((r) => occupied.server.close(r))
  })

  // E-PORT-04 CSV 批量导入
  await test('E-PORT-04', 'CSV 批量导入映射', async () => {
    const targetPort = await freeTcpPort()
    const csv = [
      'protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart',
      `tcp,127.0.0.1,${await freeTcpPort()},127.0.0.1,${targetPort},false`,
      `tcp,127.0.0.1,${await freeTcpPort()},127.0.0.1,${targetPort},false`,
      `tcp,127.0.0.1,${await freeTcpPort()},127.0.0.1,${targetPort},false`,
    ].join('\n')
    const imp = await portLogRpc('mappings.importCsv', { csv })
    assert(imp.ok && imp.value.count === 3, `导入 3 条，实际 ${imp.ok ? imp.value.count : imp.error.message}`)
    const list = await portLogRpc('mappings.list')
    assert(list.ok, 'list 成功')
    // 清理
    for (const m of imp.value.mappings) {
      await portLogRpc('mappings.remove', { id: m.id })
    }
  })

  // E-SHARE-01 会话共享端到端
  await test('E-SHARE-01', '会话共享端到端', async () => {
    const session = await connect(DEV_A)
    cleanups.push(() => disconnect(session.sessionId))
    const sharePort = await freeTcpPort()
    const start = await portLogRpc('shares.start', { sessionId: session.sessionId, localAddr: '127.0.0.1', sharePort })
    assert(start.ok, `共享启动成功`)
    // 连接共享端口
    const client = createConnection({ port: sharePort, host: '127.0.0.1' })
    await new Promise((r, rej) => { client.once('connect', r); client.once('error', rej) })
    // 等待 telnet 协商帧 + 可能的输出
    const received = await new Promise((r) => {
      let buf = Buffer.alloc(0)
      const timer = setTimeout(() => r(buf.toString()), 3000)
      client.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 10) { clearTimeout(timer); r(buf.toString()) } })
    })
    assert(received.length > 0, '共享客户端收到数据（协商帧或输出）')
    client.destroy()
    await portLogRpc('shares.stop', { sessionId: session.sessionId })
  })

  // E-SHARE-02 maxClients 限制
  await test('E-SHARE-02', '共享 maxClients 限制', async () => {
    const session = await connect(DEV_B)
    cleanups.push(() => disconnect(session.sessionId))
    const sharePort = await freeTcpPort()
    const start = await portLogRpc('shares.start', { sessionId: session.sessionId, localAddr: '127.0.0.1', sharePort, maxClients: 1 })
    assert(start.ok, '共享启动（maxClients=1）')
    // 第一个客户端连成功
    const c1 = createConnection({ port: sharePort, host: '127.0.0.1' })
    await new Promise((r, rej) => { c1.once('connect', r); c1.once('error', rej) })
    // 第二个客户端会 TCP connect 成功，但收到 "已达上限" 后被关闭
    const c2 = createConnection({ port: sharePort, host: '127.0.0.1' })
    const c2Result = await new Promise((r) => {
      let connected = false
      c2.on('connect', () => { connected = true })
      c2.on('data', (d) => { if (d.toString().includes('上限')) r('rejected') })
      c2.on('close', () => r(connected ? 'closed' : 'error'))
      c2.on('error', () => r('error'))
      setTimeout(() => r('timeout'), 3000)
    })
    assert(c2Result === 'rejected' || c2Result === 'closed', `第二客户端被拒绝（${c2Result}）`)
    c1.destroy(); c2.destroy()
    await portLogRpc('shares.stop', { sessionId: session.sessionId })
  })

  // E-SSE-01 SSE 事件订阅
  await test('E-SSE-01', 'SSE 事件订阅 → 收到 mapping-status', async () => {
    // 发起 SSE 订阅
    const sseRes = await fetch(`${DSH_ORIGIN}/term-manager/ext/port-log/events`, {
      headers: { accept: 'text/event-stream' },
    })
    assert(sseRes.ok, 'SSE 连接成功')
    const reader = sseRes.body.getReader()
    // 异步读取事件
    const eventPromise = (async () => {
      let buf = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done) break
        buf += new TextDecoder().decode(value)
        if (buf.includes('mapping-status')) return buf
      }
      return buf
    })()
    // 触发一个映射事件
    await sleep(500)
    const targetPort = await freeTcpPort()
    const mapping = await portLogRpc('mappings.create', {
      protocol: 'tcp', localAddr: '127.0.0.1', localPort: await freeTcpPort(),
      redirectAddr: '127.0.0.1', redirectPort: targetPort, autoStart: false,
    })
    assert(mapping.ok, '创建映射触发事件')
    const eventText = await eventPromise
    assert(eventText.includes('mapping-status'), 'SSE 收到 mapping-status 事件')
    await portLogRpc('mappings.remove', { id: mapping.value.id })
    try { await reader.cancel() } catch {}
  })

  // E-FILE-03 文件上传覆盖
  await test('E-FILE-03', '文件上传覆盖', async () => {
    const rootR = await rpc('files.root')
    if (!rootR.ok) { assert(false, 'files.root 失败'); return }
    const root = rootR.value.root
    const content1 = `v1-${Date.now()}`
    const content2 = `v2-${Date.now()}`
    // 第一次写入并上传
    await rpc('files.write', { root, path: `${root}/e2e-overwrite.txt`, content: content1 })
    await rpc('files.uploadLocal', { sessionId: sshSession.sessionId, remotePath: '/e2e-overwrite.txt', root, path: `${root}/e2e-overwrite.txt`, transferId: 'ow-1' })
    // 第二次写入并上传（覆盖）
    await rpc('files.write', { root, path: `${root}/e2e-overwrite.txt`, content: content2 })
    const up2 = await rpc('files.uploadLocal', { sessionId: sshSession.sessionId, remotePath: '/e2e-overwrite.txt', root, path: `${root}/e2e-overwrite.txt`, transferId: 'ow-2' })
    assert(up2.ok, '第二次上传（覆盖）成功')
    // 下载验证内容是 v2
    await rpc('files.downloadToLocal', { sessionId: sshSession.sessionId, remotePath: '/e2e-overwrite.txt', root, path: `${root}/e2e-ow-check.txt`, transferId: 'ow-check' })
    const back = await rpc('files.read', { root, path: `${root}/e2e-ow-check.txt` })
    assert(back.ok && back.value.content === content2, '覆盖后内容是 v2')
    await rm(`${root}/e2e-overwrite.txt`, { force: true })
    await rm(`${root}/e2e-ow-check.txt`, { force: true })
  })

  // E-FILE-04 下载到不存在目录
  await test('E-FILE-04', '下载到不存在目录 → 错误', async () => {
    const rootR = await rpc('files.root')
    if (!rootR.ok) { assert(false, 'files.root 失败'); return }
    const root = rootR.value.root
    const dl = await rpc('files.downloadToLocal', {
      sessionId: sshSession.sessionId, remotePath: '/e2e-up.txt',
      root, path: `${root}/nonexistent-dir/e2e-dl.txt`, transferId: 'dl-fail-1',
    })
    assert(!dl.ok, '下载到不存在目录应失败')
  })

  // 6. 清理会话
  console.log('\n▶ 清理会话')
  for (const c of cleanups) { try { await c() } catch {} }

  // 7. 结果统计
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const duration = Date.now() - totalStart

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`结果：${passed} 通过 / ${failed} 失败 / ${results.length} 总计 (${(duration / 1000).toFixed(1)}s)`)
  console.log('═'.repeat(60))

  // 8. 落盘结果
  const report = {
    timestamp: new Date().toISOString(),
    duration,
    total: results.length,
    passed,
    failed,
    results,
  }
  await mkdir(RESULTS_DIR, { recursive: true })
  await writeFile(join(RESULTS_DIR, 'e2e-results.json'), JSON.stringify(report, null, 2))
  console.log(`结果已写入：${join(RESULTS_DIR, 'e2e-results.json')}`)

  // 9. 清理进程
  cleanup()

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`致命错误: ${e.message}`)
  cleanup()
  process.exit(1)
})

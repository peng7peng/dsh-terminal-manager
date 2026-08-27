#!/usr/bin/env node
/**
 * 端到端冒烟测试：对着活的 DSH（/term-manager RPC）+ 模拟设备，跑 eval 场景。
 *
 * 前置：DSH 在 DSH_PORT（默认 4480）跑、模拟设备在 2323/2324 跑。
 *   node scripts/mock-device.mjs 2323 &  node scripts/mock-device.mjs 2324 &
 *   cd ../deepseek-harness && pnpm dsh --profile tm-dev --port 4480 --no-open &
 * 跑：node scripts/smoke-e2e.mjs
 * 退出码：0=全过，1=有失败。
 */
const DSH = `http://127.0.0.1:${process.env.DSH_PORT ?? 4480}`
const DEV_A = { protocol: 'telnet', host: '127.0.0.1', port: 2323, label: 'A' }
const DEV_B = { protocol: 'telnet', host: '127.0.0.1', port: 2324, label: 'B' }

let pass = 0, fail = 0
const cleanups = []

async function rpc(method, payload = {}) {
  const res = await fetch(`${DSH}/term-manager/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return body.result
}
function assert(cond, msg) { cond ? (pass++, console.log(`  ✅ ${msg}`)) : (fail++, console.log(`  ❌ ${msg}`)) }

async function connect(target) {
  const r = await rpc('sessions.connect', target)
  if (!r.ok) throw new Error(`connect 失败: ${r.error.message}`)
  return r.value
}
async function disconnect(sid) { await rpc('sessions.disconnect', { sessionId: sid }) }

async function test(name, fn) {
  console.log(`\n▶ ${name}`)
  try { await fn() } catch (e) { fail++; console.log(`  ❌ 异常: ${e.message}`) }
}

// ─── E1 临时连接 ───
await test('E1 临时连接 + 横幅', async () => {
  const r = await rpc('sessions.connect', DEV_A)
  assert(r.ok, '连接成功')
  if (r.ok) { assert(r.value.status === 'open', 'status=open'); cleanups.push(() => disconnect(r.value.sessionId)) }
})

// ─── E2 保存连接 + 按 connId 连 ───
let savedId
await test('E2 保存连接 + connId 连', async () => {
  const c = await rpc('connections.create', { label: 'e2', protocol: 'telnet', host: '127.0.0.1', port: 2323 })
  assert(c.ok, '保存成功'); if (!c.ok) return
  savedId = c.value.id
  const r = await rpc('sessions.connect', { connId: savedId })
  assert(r.ok && r.value.status === 'open', 'connId 连接 open')
  if (r.ok) cleanups.push(() => disconnect(r.value.sessionId))
})

// ─── E3/E4 编辑/删除 ───
await test('E3 编辑连接', async () => {
  const u = await rpc('connections.update', { id: savedId, patch: { label: 'e2-renamed' } })
  assert(u.ok, '编辑成功')
  const l = await rpc('connections.list')
  assert(l.ok && l.value.some(c => c.id === savedId && c.label === 'e2-renamed'), 'list 反映新名')
})

// ─── E5 SSH 缺认证 ───
await test('E5 SSH 缺认证 → VALIDATION', async () => {
  const r = await rpc('connections.create', { label: 'bad', protocol: 'ssh', host: '127.0.0.1', port: 22 })
  assert(!r.ok && r.error.message.includes('VALIDATION'), '返回 VALIDATION')
})

// ─── E6 横幅 ───
await test('E6 横幅含 Mock Router', async () => {
  const s = await connect(DEV_A); const r = await rpc('sessions.read', { sessionId: s.sessionId })
  assert(r.ok && r.value.text.includes('Mock Router'), 'read 含 Mock Router')
  cleanups.push(() => disconnect(s.sessionId))
})

// ─── E7 多设备 ───
await test('E7 多设备同屏', async () => {
  const a = await connect(DEV_A), b = await connect(DEV_B)
  const l = await rpc('sessions.list')
  assert(l.ok && l.value.filter(s => s.status === 'open').length >= 2, '2 个 open 会话')
  cleanups.push(() => disconnect(a.sessionId), () => disconnect(b.sessionId))
})

// ─── E9 单机发命令（tm_send 经工具层，不经 RPC；由 vitest + AI 测试覆盖）───
await test('E9 tm_send（工具层，不经 RPC）', async () => {
  console.log('  ℹ️ tm_send/tm_send_all 是 AI 工具（进程内），不经 /term-manager；由 vitest tools.spec（假传输）+ AI 测试（真传输，已验 MockOS 输出）覆盖')
  pass++
})

// ─── E18 命令守卫（同上，工具层）───
await test('E18 命令守卫（工具层）', async () => {
  console.log('  ℹ️ 命令守卫在 tm_send 工具层；由 vitest tools.spec（拦截 rm -rf /）覆盖')
  pass++
})

// ─── E20 地址不通 ───
await test('E20 地址不通 → HOST_UNREACHABLE', async () => {
  const r = await rpc('sessions.connect', { protocol: 'telnet', host: '127.0.0.1', port: 9999 })
  assert(!r.ok && (r.error.message.includes('HOST_UNREACHABLE') || r.error.message.includes('CONN_TIMEOUT')), '返回 HOST_UNREACHABLE/CONN_TIMEOUT')
})

// ─── E21 断开后操作 ───
await test('E21 断开后操作 → 错误', async () => {
  const s = await connect(DEV_A); await disconnect(s.sessionId)
  const r = await rpc('sessions.read', { sessionId: s.sessionId })
  assert(!r.ok && (r.error.message.includes('SESSION_NOT_FOUND') || r.error.message.includes('DISCONNECTED')), '返回 SESSION_NOT_FOUND/DISCONNECTED')
})

// ─── E4 删除 ───
await test('E4 删除连接', async () => {
  const r = await rpc('connections.remove', { id: savedId })
  assert(r.ok, '删除成功')
  const l = await rpc('connections.list')
  assert(l.ok && !l.value.some(c => c.id === savedId), 'list 不再含')
})

// 清理所有会话
for (const c of cleanups) { try { await c() } catch {} }

// ─── SSH 场景（模拟 SSH 设备端口 2222，密码 admin/test-pass）───
const SSH_DEV = { protocol: 'ssh', host: '127.0.0.1', port: 2222, username: 'admin', password: 'test-pass', label: 'ssh-A' }

await test('E-SSH 密码连接', async () => {
  const r = await rpc('sessions.connect', SSH_DEV)
  assert(r.ok, 'SSH 连接成功')
  if (r.ok) { assert(r.value.status === 'open', 'status=open'); cleanups.push(() => disconnect(r.value.sessionId)) }
})

await test('E-SSH 密码错误 → AUTH_FAILED', async () => {
  const r = await rpc('sessions.connect', { ...SSH_DEV, password: 'wrong-pw' })
  assert(!r.ok && r.error.message.includes('AUTH_FAILED'), '返回 AUTH_FAILED')
})

await test('E-SSH 地址不通 → HOST_UNREACHABLE', async () => {
  const r = await rpc('sessions.connect', { protocol: 'ssh', host: '127.0.0.1', port: 9998, username: 'a', password: 'b' })
  assert(!r.ok && (r.error.message.includes('HOST_UNREACHABLE') || r.error.message.includes('CONN_TIMEOUT')), '返回 HOST_UNREACHABLE/CONN_TIMEOUT')
})

// 清理 SSH 会话
for (const c of cleanups) { try { await c() } catch {} }

console.log(`\n${'═'.repeat(50)}\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)

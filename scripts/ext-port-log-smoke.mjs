#!/usr/bin/env node
/** 对活的 DSH 扩展控制面执行 TCP/UDP/CSV/敏感信息冒烟测试。 */
import { readFile } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { createSocket } from 'node:dgram'

const origin = `http://127.0.0.1:${process.env.DSH_PORT ?? '3180'}`
const createdIds = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✅ ${message}`)
}

async function rpc(method, payload = {}) {
  const response = await fetch(`${origin}/term-manager/ext/port-log`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (!body.result.ok) throw new Error(`${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

async function tcpEcho() {
  const server = createServer((socket) => socket.pipe(socket))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server
}

async function freeTcpPort() {
  const server = await tcpEcho()
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function tcpRoundTrip(port, text) {
  const socket = createConnection({ port, host: '127.0.0.1' })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const reply = new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject) })
  socket.write(text)
  const data = await reply
  socket.destroy()
  return data.toString()
}

async function udpEcho() {
  const socket = createSocket('udp4')
  socket.on('message', (message, source) => socket.send(message, source.port, source.address))
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve) })
  return socket
}

async function freeUdpPort() {
  const socket = await udpEcho()
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function udpRoundTrip(port, text) {
  const socket = createSocket('udp4')
  const reply = new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject) })
  await new Promise((resolve, reject) => socket.send(Buffer.from(text), port, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const data = await reply
  await new Promise((resolve) => socket.close(resolve))
  return data.toString()
}

const tcpTarget = await tcpEcho()
const udpTarget = await udpEcho()
try {
  const tcpLocal = await freeTcpPort()
  const tcp = await rpc('mappings.create', {
    protocol: 'tcp', localAddr: '127.0.0.1', localPort: tcpLocal,
    redirectAddr: '127.0.0.1', redirectPort: tcpTarget.address().port,
    autoStart: false, password: 'SMOKE_SECRET_MUST_NOT_APPEAR',
  })
  createdIds.push(tcp.id)
  await rpc('mappings.start', { id: tcp.id })
  assert(await tcpRoundTrip(tcpLocal, 'tcp-smoke') === 'tcp-smoke', 'TCP 双向转发')
  await rpc('mappings.stop', { id: tcp.id })

  const udpLocal = await freeUdpPort()
  const udp = await rpc('mappings.create', {
    protocol: 'udp', localAddr: '127.0.0.1', localPort: udpLocal,
    redirectAddr: '127.0.0.1', redirectPort: udpTarget.address().port, autoStart: false,
  })
  createdIds.push(udp.id)
  await rpc('mappings.start', { id: udp.id })
  assert(await udpRoundTrip(udpLocal, 'udp-smoke') === 'udp-smoke', 'UDP 数据报双向转发')
  await rpc('mappings.stop', { id: udp.id })

  const exported = await rpc('mappings.exportCsv')
  assert(exported.csv.includes('protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart'), 'CSV 导出表头')
  const appLog = await rpc('appLogs.status')
  const logText = (await Promise.all(appLog.files.map((file) => readFile(file.path, 'utf8')))).join('\n')
  assert(!logText.includes('SMOKE_SECRET_MUST_NOT_APPEAR'), '应用日志不记录 RPC 敏感载荷')
} finally {
  for (const id of createdIds) {
    try { await rpc('mappings.stop', { id }) } catch {}
    try { await rpc('mappings.remove', { id }) } catch {}
  }
  await new Promise((resolve) => tcpTarget.close(resolve))
  await new Promise((resolve) => udpTarget.close(resolve))
}

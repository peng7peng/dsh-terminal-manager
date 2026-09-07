import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'

export async function listenTcpEcho(host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP server did not bind')
  return { server, port: address.port }
}

export async function freeTcpPort(host = '127.0.0.1'): Promise<number> {
  const { server, port } = await listenTcpEcho(host)
  await closeTcpServer(server)
  return port
}

export async function closeTcpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

export function connectTcp(port: number, host = '127.0.0.1'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host })
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

export function readTcp(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
  })
}

export async function listenUdpEcho(host = '127.0.0.1'): Promise<{ socket: UdpSocket; port: number }> {
  const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4')
  socket.on('message', (message, source) => socket.send(message, source.port, source.address))
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, host, resolve)
  })
  const address = socket.address()
  return { socket, port: address.port }
}

export async function freeUdpPort(host = '127.0.0.1'): Promise<number> {
  const { socket, port } = await listenUdpEcho(host)
  await closeUdp(socket)
  return port
}

export function closeUdp(socket: UdpSocket): Promise<void> {
  return new Promise((resolve) => {
    try { socket.close(() => resolve()) } catch { resolve() }
  })
}

export async function udpRoundTrip(socket: UdpSocket, message: Buffer, port: number, host = '127.0.0.1'): Promise<Buffer> {
  const reply = new Promise<Buffer>((resolve, reject) => {
    socket.once('message', resolve)
    socket.once('error', reject)
  })
  await new Promise<void>((resolve, reject) => socket.send(message, port, host, (error) => error ? reject(error) : resolve()))
  return reply
}

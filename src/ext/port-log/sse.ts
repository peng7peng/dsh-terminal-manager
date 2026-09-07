import type { ServerResponse } from 'node:http'

export interface RuntimeEvent {
  type: string
  data: unknown
}

export class RuntimeEventHub {
  private readonly clients = new Set<ServerResponse>()
  private closed = false

  get clientCount(): number {
    return this.clients.size
  }

  subscribe(response: ServerResponse): () => void {
    if (this.closed) {
      response.end()
      return () => undefined
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    this.clients.add(response)
    const remove = (): void => { this.clients.delete(response) }
    response.once('close', remove)
    return remove
  }

  publish(event: RuntimeEvent): void {
    if (this.closed) return
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const client of [...this.clients]) {
      if (!client.write(frame)) {
        this.clients.delete(client)
        client.end()
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}

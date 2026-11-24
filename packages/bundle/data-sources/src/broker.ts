import { createServer, type Server, type Socket } from 'node:net'
import { chmod, rm } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_FRAME_BYTES = 64 * 1024
const DEADLINE_MS = 10_000

export interface BrokerRequest { operation: string; arguments: Record<string, unknown> }
export type BrokerEndpoint = { transport: 'unix'; path: string } | { transport: 'tcp'; host: '127.0.0.1'; port: number }
export interface BrokerBootstrap { endpoint: BrokerEndpoint; capability: string }

/** Single-use Host-private IPC broker: framed, capability-gated and bounded before any source admission. */
export class DataSourcesBroker {
  #server: Server | undefined
  #sockets = new Set<Socket>()
  #path: string | undefined
  readonly #capability = randomBytes(32).toString('base64url')

  constructor(private readonly handle: (request: BrokerRequest) => Promise<unknown>) {}

  async start(): Promise<BrokerBootstrap> {
    if (this.#server !== undefined) throw new Error('data-sources: broker already started')
    const server = createServer(socket => this.#connection(socket))
    this.#server = server
    if (process.platform === 'win32') {
      const endpoint = await listenTcp(server)
      return { endpoint, capability: this.#capability }
    }
    const path = join(tmpdir(), `dsh-data-sources-${randomBytes(16).toString('hex')}.sock`)
    this.#path = path
    await listenUnix(server, path)
    await chmod(path, 0o600)
    return { endpoint: { transport: 'unix', path }, capability: this.#capability }
  }

  async dispose(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    const server = this.#server; this.#server = undefined
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
    if (this.#path !== undefined) await rm(this.#path, { force: true })
    this.#path = undefined
  }

  #connection(socket: Socket): void {
    this.#sockets.add(socket)
    socket.setTimeout(DEADLINE_MS, () => socket.destroy())
    let buffered = Buffer.alloc(0)
    socket.on('data', (value) => {
      buffered = Buffer.concat([buffered, value])
      if (buffered.byteLength > MAX_FRAME_BYTES || buffered.indexOf(10) < 0) { socket.destroy(); return }
      const lineEnd = buffered.indexOf(10)
      if (lineEnd > MAX_FRAME_BYTES || lineEnd + 1 !== buffered.byteLength) { socket.destroy(); return }
      void this.#respond(socket, buffered.subarray(0, lineEnd))
    })
    socket.once('close', () => this.#sockets.delete(socket))
    socket.once('error', () => socket.destroy())
  }

  async #respond(socket: Socket, frame: Buffer): Promise<void> {
    try {
      const message = JSON.parse(frame.toString('utf8')) as { capability?: unknown; operation?: unknown; arguments?: unknown }
      if (typeof message.capability !== 'string' || !sameCapability(message.capability, this.#capability)) throw new Error('unauthorized')
      if (typeof message.operation !== 'string' || typeof message.arguments !== 'object' || message.arguments === null || Array.isArray(message.arguments)) throw new Error('invalid request')
      const result = await this.handle({ operation: message.operation, arguments: message.arguments as Record<string, unknown> })
      write(socket, { ok: true, result })
    } catch { write(socket, { ok: false }) }
  }
}

function sameCapability(value: string, expected: string): boolean {
  const actual = Buffer.from(value); const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}
function write(socket: Socket, value: unknown): void { socket.end(`${JSON.stringify(value)}\n`) }
function listenUnix(server: Server, path: string): Promise<void> { return new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve)) }
function listenTcp(server: Server): Promise<Extract<BrokerEndpoint, { transport: 'tcp' }>> { return new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => { const address = server.address(); if (address === null || typeof address === 'string') { reject(new Error('data-sources: broker has no TCP endpoint')); return }; resolve({ transport: 'tcp', host: '127.0.0.1', port: address.port }) })) }

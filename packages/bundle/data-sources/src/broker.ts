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
export interface BrokerOptions { transport?: 'unix' | 'tcp'; /** Test-only tightening; production cannot exceed the hard deadline. */ deadlineMs?: number }

/** Single-use Host-private IPC broker: bounded, capability-gated, and abortable before source admission. */
export class DataSourcesBroker {
  #server: Server | undefined
  #connections = new Map<Socket, AbortController>()
  #path: string | undefined
  readonly #capability = randomBytes(32).toString('base64url')
  readonly #transport: 'unix' | 'tcp'
  readonly #deadlineMs: number

  constructor(private readonly handle: (request: BrokerRequest, signal: AbortSignal) => Promise<unknown>, options: BrokerOptions = {}) {
    this.#transport = options.transport ?? (process.platform === 'win32' ? 'tcp' : 'unix')
    this.#deadlineMs = Math.min(options.deadlineMs ?? DEADLINE_MS, DEADLINE_MS)
    if (!Number.isInteger(this.#deadlineMs) || this.#deadlineMs < 1) throw new Error('data-sources: broker deadline must be positive')
  }

  async start(): Promise<BrokerBootstrap> {
    if (this.#server !== undefined) throw new Error('data-sources: broker already started')
    const server = createServer(socket => this.#connection(socket))
    this.#server = server
    if (this.#transport === 'tcp') return { endpoint: await listenTcp(server), capability: this.#capability }
    const path = join(tmpdir(), `dsh-data-sources-${randomBytes(16).toString('hex')}.sock`)
    this.#path = path
    await listenUnix(server, path)
    await chmod(path, 0o600)
    return { endpoint: { transport: 'unix', path }, capability: this.#capability }
  }

  async dispose(): Promise<void> {
    for (const [socket, controller] of this.#connections) { controller.abort(); socket.destroy() }
    const server = this.#server; this.#server = undefined
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
    if (this.#path !== undefined) await rm(this.#path, { force: true })
    this.#path = undefined
  }

  #connection(socket: Socket): void {
    const controller = new AbortController(); this.#connections.set(socket, controller)
    const hardDeadline = setTimeout(() => { controller.abort(); socket.destroy() }, this.#deadlineMs)
    let buffered = Buffer.alloc(0); let dispatched = false
    socket.on('data', (value: Buffer) => {
      if (dispatched || value.byteLength > MAX_FRAME_BYTES - buffered.byteLength) { socket.destroy(); return }
      buffered = Buffer.concat([buffered, value])
      const lineEnd = buffered.indexOf(10)
      if (lineEnd < 0) return
      if (lineEnd + 1 !== buffered.byteLength) { socket.destroy(); return }
      dispatched = true
      void this.#respond(socket, buffered.subarray(0, lineEnd), controller.signal)
    })
    socket.once('close', () => { clearTimeout(hardDeadline); controller.abort(); this.#connections.delete(socket) })
    socket.once('error', () => socket.destroy())
  }

  async #respond(socket: Socket, frame: Buffer, signal: AbortSignal): Promise<void> {
    try {
      const message = JSON.parse(frame.toString('utf8')) as { capability?: unknown; operation?: unknown; arguments?: unknown }
      if (typeof message.capability !== 'string' || !sameCapability(message.capability, this.#capability)) throw new Error('unauthorized')
      if (typeof message.operation !== 'string' || typeof message.arguments !== 'object' || message.arguments === null || Array.isArray(message.arguments)) throw new Error('invalid request')
      const result = await this.handle({ operation: message.operation, arguments: message.arguments as Record<string, unknown> }, signal)
      write(socket, { ok: true, result })
    } catch { write(socket, { ok: false }) }
  }
}

function sameCapability(value: string, expected: string): boolean {
  const actual = Buffer.from(value); const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}
function write(socket: Socket, value: unknown): void {
  let payload = '{"ok":false}'
  try {
    const candidate = JSON.stringify(value)
    if (Buffer.byteLength(candidate) <= MAX_FRAME_BYTES) payload = candidate
  } catch {}
  socket.end(`${payload}\n`)
}
function listenUnix(server: Server, path: string): Promise<void> { return new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve)) }
function listenTcp(server: Server): Promise<Extract<BrokerEndpoint, { transport: 'tcp' }>> { return new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => { const address = server.address(); if (address === null || typeof address === 'string') { reject(new Error('data-sources: broker has no TCP endpoint')); return }; resolve({ transport: 'tcp', host: '127.0.0.1', port: address.port }) })) }

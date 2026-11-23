/* oxlint-disable typescript/no-non-null-assertion, @stylistic/max-len -- Protocol frames require indexed reads; config validation establishes coordinates. */
import net from 'node:net'
import tls from 'node:tls'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

/** Upper bound prevents a hostile peer from forcing unbounded frame/row buffering. */
const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024

function auth(value: string | undefined): { username: string; password?: string } {
  if (!value) throw new Error('data-sources: PostgreSQL credential is required')
  try { const v = JSON.parse(value) as Record<string, unknown>; if (typeof v.username === 'string') return { username: v.username, ...(typeof v.password === 'string' ? { password: v.password } : {}) } } catch {}
  throw new Error('data-sources: PostgreSQL credential must be JSON with username and optional password')
}
function message(type: string, body: Buffer): Buffer { const length = Buffer.alloc(4); length.writeUInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), length, body]) }
function cstring(value: string): Buffer { return Buffer.from(`${value}\0`) }

/** Upgrade a connected PostgreSQL socket with strict certificate validation when TLS is configured. */
async function upgradeTls(socket: net.Socket, source: ConnectorRequest['source']): Promise<net.Socket | tls.TLSSocket> {
  const options = source.connection?.tls
  if (options === undefined) return socket
  const ca = options.caPath === undefined ? undefined : await readFile(options.caPath)
  const request = Buffer.alloc(8)
  request.writeUInt32BE(8, 0)
  request.writeUInt32BE(80_877_103, 4)
  socket.write(request)
  const response = await new Promise<number>((resolve, reject) => {
    socket.once('data', data => resolve(data[0] ?? 0))
    socket.once('error', reject)
  })
  if (response !== 'S'.charCodeAt(0)) throw new Error('data-sources: PostgreSQL server does not support required TLS')
  const secure = tls.connect({ socket, servername: options.serverName ?? source.connection?.host, rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) })
  await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject) })
  return secure
}

/** PostgreSQL v3 protocol reader, intentionally supporting only authentication and simple Query messages. */
export class PostgreSqlConnector implements ReadConnector {
  readonly kind = 'postgresql' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#query(request, 'SELECT 1') }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const sql = request.request.operation === 'catalog' ? 'SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = \'BASE TABLE\' ORDER BY 1,2' : String(request.request.input.sql)
    const result = await this.#query(request, sql)
    return { data: { columns: result.columns, rows: result.rows }, truncated: result.truncated }
  }
  async #query(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, sql: string): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    const { host, port = 5432, database } = request.source.connection!; const credential = auth(request.credential)
    const socket = net.createConnection({ host, port })
    const timeout = request.source.connection?.timeoutMs ?? 10_000
    const deadline = setTimeout(() => socket.destroy(new Error(`data-sources: PostgreSQL operation timed out after ${timeout}ms`)), timeout)
    let buffer = Buffer.alloc(0)
    let ready = false
    let querySent = false
    const statementTimeout = request.source.connection?.statementTimeoutMs ?? timeout
    let columns: string[] = []
    const rows: unknown[][] = []
    const limits = 'request' in request ? request.request : undefined
    const maxRows = limits?.maxRows ?? Number.POSITIVE_INFINITY
    const maxBytes = limits?.maxBytes ?? Number.POSITIVE_INFINITY
    let emittedBytes = 0
    let truncated = false
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const transport = await upgradeTls(socket, request.source)
    const startup = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 3, 0, 0]), cstring('user'), cstring(credential.username), cstring('database'), cstring(database!), Buffer.from([0])]); startup.writeUInt32BE(startup.length)
    transport.write(startup)
    const done = new Promise<void>((resolve, reject) => {
      transport.on('error', reject); transport.on('data', (data) => {
        if (buffer.length + data.length > MAX_PROTOCOL_MESSAGE_BYTES + 5) {
          transport.destroy(); reject(new Error('data-sources: PostgreSQL protocol message exceeds the memory limit')); return
        }
        buffer = Buffer.concat([buffer, data]); while (buffer.length >= 5) { const type = String.fromCharCode(buffer[0]!); const len = buffer.readUInt32BE(1); if (len < 4 || len > MAX_PROTOCOL_MESSAGE_BYTES + 4) { transport.destroy(); reject(new Error('data-sources: PostgreSQL protocol message exceeds the memory limit')); return } if (buffer.length < len + 1) return; const body = buffer.subarray(5, len + 1); buffer = buffer.subarray(len + 1)
          if (type === 'R') { const code = body.readUInt32BE(0); if (code === 0) continue; if (code === 3 && credential.password) transport.write(message('p', cstring(credential.password))); else if (code === 5 && credential.password) { const salt = body.subarray(4, 8); const inner = createHash('md5').update(`${credential.password}${credential.username}`).digest('hex'); const value = `md5${createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')}`; transport.write(message('p', cstring(value))) } else reject(new Error('data-sources: PostgreSQL authentication method is unsupported'))
          } else if (type === 'Z') {
            if (!ready) {
              ready = true
              transport.write(message('Q', cstring(`SET statement_timeout = ${statementTimeout}`)))
            } else if (!querySent) {
              querySent = true
              transport.write(message('Q', cstring(sql)))
            } else resolve()
          } else if (type === 'E') reject(new Error(`data-sources: PostgreSQL query rejected: ${body.toString('utf8')}`))
          else if (type === 'T') { let at = 2; const count = body.readUInt16BE(0); columns = []; for (let i = 0; i < count; i++) { const end = body.indexOf(0, at); columns.push(body.toString('utf8', at, end)); at = end + 19 } } else if (type === 'D') { const count = body.readUInt16BE(0); let at = 2; const row: unknown[] = []; for (let i = 0; i < count; i++) { const length = body.readInt32BE(at); at += 4; if (length < 0) row.push(null); else { row.push(body.toString('utf8', at, at + length)); at += length } } const size = Buffer.byteLength(JSON.stringify(row)); if (rows.length >= maxRows || emittedBytes + size > maxBytes) { truncated = true; resolve(); transport.destroy(); return } rows.push(row); emittedBytes += size }
        }
      })
    })
    try { await done; return { columns, rows, truncated } } finally { clearTimeout(deadline); transport.end() }
  }
}

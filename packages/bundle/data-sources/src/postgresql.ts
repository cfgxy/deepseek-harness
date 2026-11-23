/* oxlint-disable typescript/no-non-null-assertion, @stylistic/max-len -- Protocol frames require indexed reads; config validation establishes coordinates. */
import net from 'node:net'
import { createHash } from 'node:crypto'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

function auth(value: string | undefined): { username: string; password?: string } {
  if (!value) throw new Error('data-sources: PostgreSQL credential is required')
  try { const v = JSON.parse(value) as Record<string, unknown>; if (typeof v.username === 'string') return { username: v.username, ...(typeof v.password === 'string' ? { password: v.password } : {}) } } catch {}
  throw new Error('data-sources: PostgreSQL credential must be JSON with username and optional password')
}
function message(type: string, body: Buffer): Buffer { const length = Buffer.alloc(4); length.writeUInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), length, body]) }
function cstring(value: string): Buffer { return Buffer.from(`${value}\0`) }
function rowBudget(rows: unknown[][], bytes: number, maxRows: number): { rows: unknown[][]; truncated: boolean } { let used = 0; const out: unknown[][] = []; for (const row of rows) { const size = Buffer.byteLength(JSON.stringify(row)); if (out.length === maxRows || used + size > bytes) return { rows: out, truncated: true }; out.push(row); used += size } return { rows: out, truncated: false } }

/** PostgreSQL v3 protocol reader, intentionally supporting only authentication and simple Query messages. */
export class PostgreSqlConnector implements ReadConnector {
  readonly kind = 'postgresql' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#query(request, 'SELECT 1') }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const sql = request.request.operation === 'catalog' ? 'SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = \'BASE TABLE\' ORDER BY 1,2' : String(request.request.input.sql)
    const result = await this.#query(request, sql)
    const bounded = rowBudget(result.rows, request.request.maxBytes!, request.request.maxRows!)
    return { data: { columns: result.columns, rows: bounded.rows }, truncated: bounded.truncated }
  }
  async #query(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    const { host, port = 5432, database } = request.source.connection!; const credential = auth(request.credential)
    const socket = net.createConnection({ host, port }); let buffer = Buffer.alloc(0); let ready = false; let columns: string[] = []; const rows: unknown[][] = []
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const startup = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 3, 0, 0]), cstring('user'), cstring(credential.username), cstring('database'), cstring(database!), Buffer.from([0])]); startup.writeUInt32BE(startup.length)
    socket.write(startup)
    const done = new Promise<void>((resolve, reject) => {
      socket.on('error', reject); socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]); while (buffer.length >= 5) { const type = String.fromCharCode(buffer[0]!); const len = buffer.readUInt32BE(1); if (buffer.length < len + 1) return; const body = buffer.subarray(5, len + 1); buffer = buffer.subarray(len + 1)
          if (type === 'R') { const code = body.readUInt32BE(0); if (code === 0) continue; if (code === 3 && credential.password) socket.write(message('p', cstring(credential.password))); else if (code === 5 && credential.password) { const salt = body.subarray(4, 8); const inner = createHash('md5').update(`${credential.password}${credential.username}`).digest('hex'); const value = `md5${createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')}`; socket.write(message('p', cstring(value))) } else reject(new Error('data-sources: PostgreSQL authentication method is unsupported'))
          } else if (type === 'Z') { if (!ready) { ready = true; socket.write(message('Q', cstring(sql))) } else resolve() } else if (type === 'E') reject(new Error(`data-sources: PostgreSQL query rejected: ${body.toString('utf8')}`))
          else if (type === 'T') { let at = 2; const count = body.readUInt16BE(0); columns = []; for (let i = 0; i < count; i++) { const end = body.indexOf(0, at); columns.push(body.toString('utf8', at, end)); at = end + 19 } } else if (type === 'D') { const count = body.readUInt16BE(0); let at = 2; const row: unknown[] = []; for (let i = 0; i < count; i++) { const length = body.readInt32BE(at); at += 4; if (length < 0) row.push(null); else { row.push(body.toString('utf8', at, at + length)); at += length } } rows.push(row) }
        }
      })
    })
    try { await done; return { columns, rows } } finally { socket.end() }
  }
}

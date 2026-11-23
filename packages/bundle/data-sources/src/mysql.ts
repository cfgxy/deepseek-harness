/* oxlint-disable typescript/no-non-null-assertion, @stylistic/max-len -- Protocol frames require indexed reads; config validation establishes coordinates. */
import net from 'node:net'
import tls from 'node:tls'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

/** Upper bound prevents a hostile peer from forcing unbounded packet/row buffering. */
const MAX_PROTOCOL_PACKET_BYTES = 1024 * 1024
function auth(value: string | undefined): { username: string; password: string } { if (!value) throw new Error('data-sources: MySQL credential is required'); try { const v = JSON.parse(value) as Record<string, unknown>; if (typeof v.username === 'string' && typeof v.password === 'string') return { username: v.username, password: v.password } } catch {}; throw new Error('data-sources: MySQL credential must be JSON with username and password') }
function packet(payload: Buffer, sequence: number): Buffer { const h = Buffer.alloc(4); h.writeUIntLE(payload.length, 0, 3); h[3] = sequence; return Buffer.concat([h, payload]) }
function nul(value: string): Buffer { return Buffer.from(`${value}\0`) }
function token(password: string, seed: Buffer): Buffer { const one = createHash('sha1').update(password).digest(); const two = createHash('sha1').update(one).digest(); const three = createHash('sha1').update(Buffer.concat([seed, two])).digest(); return Buffer.from(one.map((b, i) => b ^ three[i]!)) }
function readLen(buf: Buffer, at: number): [number, number] { const n = buf[at]!; if (n < 0xfb) return [n, at + 1]; if (n === 0xfc) return [buf.readUInt16LE(at + 1), at + 3]; if (n === 0xfd) return [buf.readUIntLE(at + 1, 3), at + 4]; return [Number(buf.readBigUInt64LE(at + 1)), at + 9] }

/** TLS is opt-in, but every configured session validates its peer certificate. */
async function upgradeTls(socket: net.Socket, request: ConnectorRequest['source']): Promise<tls.TLSSocket> {
  const options = request.connection?.tls
  if (options === undefined) throw new Error('data-sources: MySQL TLS options are missing')
  const ca = options.caPath === undefined ? undefined : await readFile(options.caPath)
  const secure = tls.connect({ socket, servername: options.serverName ?? request.connection?.host, rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) })
  await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject) })
  return secure
}
/** Classic MySQL protocol read connector: only mysql_native_password and COM_QUERY SELECT are intentionally implemented. */
export class MysqlConnector implements ReadConnector {
  readonly kind = 'mysql' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#query(request, 'SELECT 1') }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> { const sql = request.request.operation === 'catalog' ? 'SHOW TABLES' : String(request.request.input.sql); const result = await this.#query(request, sql); return { data: { columns: result.columns, rows: result.rows }, truncated: result.truncated } }
  async #query(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, sql: string): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    const credential = auth(request.credential); const { host, port = 3306, database } = request.source.connection!
    let socket: net.Socket | tls.TLSSocket = net.createConnection({ host, port })
    const timeout = request.source.connection?.timeoutMs ?? 10_000
    const deadline = setTimeout(() => socket.destroy(new Error(`data-sources: MySQL operation timed out after ${timeout}ms`)), timeout)
    let buffer = Buffer.alloc(0); const columns: string[] = []; const rows: unknown[][] = []; let expectedColumns = 0; let readyForRows = false
    const limits = 'request' in request ? request.request : undefined
    const maxRows = limits?.maxRows ?? Number.POSITIVE_INFINITY
    const maxBytes = limits?.maxBytes ?? Number.POSITIVE_INFINITY
    let emittedBytes = 0
    let truncated = false
    const send = (body: Buffer, seq: number) => socket.write(packet(body, seq))
    let waiter: { resolve: (value: Buffer) => void; reject: (error: Error) => void } | undefined
    let protocolError: Error | undefined
    const take = (): Buffer | undefined => { if (buffer.length < 4) return undefined; const n = buffer.readUIntLE(0, 3); if (n > MAX_PROTOCOL_PACKET_BYTES) { protocolError = new Error('data-sources: MySQL protocol packet exceeds the memory limit'); return undefined } if (buffer.length < n + 4) return undefined; const body = buffer.subarray(4, n + 4); buffer = buffer.subarray(n + 4); return body }
    const onData = (data: Buffer): void => {
      if (buffer.length + data.length > MAX_PROTOCOL_PACKET_BYTES + 4) protocolError = new Error('data-sources: MySQL protocol packet exceeds the memory limit')
      else buffer = Buffer.concat([buffer, data])
      const item = take(); const pending = waiter
      if (protocolError !== undefined) { socket.destroy(); waiter = undefined; pending?.reject(protocolError); return }
      if (item !== undefined && pending !== undefined) { waiter = undefined; pending.resolve(item) }
    }
    socket.on('data', onData)
    const next = (): Promise<Buffer> => new Promise((resolve, reject) => { if (protocolError !== undefined) { reject(protocolError); return } const item = take(); if (protocolError !== undefined) reject(protocolError); else if (item !== undefined) resolve(item); else waiter = { resolve, reject } })
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    try {
      const hello = await next(); let at = 1; const serverEnd = hello.indexOf(0, at); const serverVersion = hello.toString('utf8', at, serverEnd); at = serverEnd + 1 + 4; const seed1 = hello.subarray(at, at + 8); at += 9; const capsLow = hello.readUInt16LE(at); at += 2 + 1 + 2; const capsHigh = hello.readUInt16LE(at); at += 2; const caps = (capsLow | (capsHigh << 16)) >>> 0; const authLength = hello[at++]!; at += 10; const seed2 = hello.subarray(at, at + Math.max(13, authLength - 8)).subarray(0, 12); const pluginAt = hello.indexOf(0, at + Math.max(13, authLength - 8)); const plugin = hello.toString('utf8', at + Math.max(13, authLength - 8), pluginAt < 0 ? undefined : pluginAt)
      if (plugin && plugin !== 'mysql_native_password') throw new Error(`data-sources: MySQL authentication ${plugin} is unsupported; configure mysql_native_password for this read-only connector`)
      const baseCapability = (caps & (0x00000001 | 0x00000004 | 0x00000008 | 0x00000200 | 0x00002000 | 0x00008000 | 0x00020000 | 0x00080000)) >>> 0
      const wantsTls = request.source.connection?.tls !== undefined
      if (wantsTls && (caps & 0x00000800) === 0) throw new Error('data-sources: MySQL server does not support required TLS')
      const capability = (baseCapability | (wantsTls ? 0x00000800 : 0)) >>> 0
      const header = Buffer.alloc(4 + 4 + 1 + 23); header.writeUInt32LE(capability, 0); header.writeUInt32LE(16 * 1024 * 1024, 4); header[8] = 45
      if (wantsTls) {
        send(header, 1)
        socket.off('data', onData)
        socket = await upgradeTls(socket as net.Socket, request.source)
        socket.on('data', onData)
      }
      const response = Buffer.concat([header, nul(credential.username), Buffer.from([20]), token(credential.password, Buffer.concat([seed1, seed2])), nul(database!), nul('mysql_native_password')]); send(response, wantsTls ? 2 : 1); const authOk = await next(); if (authOk[0] !== 0) throw new Error(`data-sources: MySQL authentication rejected: ${authOk.toString('utf8')}`)
      const statementTimeout = request.source.connection?.statementTimeoutMs ?? timeout
      const setting = /mariadb/i.test(serverVersion)
        ? `SET SESSION max_statement_time = ${statementTimeout / 1000}`
        : `SET SESSION max_execution_time = ${statementTimeout}`
      send(Buffer.concat([Buffer.from([3]), Buffer.from(setting)]), 0)
      const setup = await next()
      if (setup[0] !== 0) throw new Error(`data-sources: MySQL statement timeout setup rejected: ${setup.toString('utf8')}`)
      send(Buffer.concat([Buffer.from([3]), Buffer.from(sql)]), 0); const first = await next(); if (first[0] === 0xff) throw new Error(`data-sources: MySQL query rejected: ${first.toString('utf8')}`); [expectedColumns] = readLen(first, 0)
      for (let i = 0; i < expectedColumns; i++) { const field = await next(); let cursor = 0; for (let j = 0; j < 4; j++) { const [n, nextAt] = readLen(field, cursor); cursor = nextAt + n } const [nameLen, nameAt] = readLen(field, cursor); columns.push(field.toString('utf8', nameAt, nameAt + nameLen)) }
      await next(); readyForRows = true
      while (readyForRows) { const row = await next(); if (row[0] === 0xfe && row.length < 9) break; if (row[0] === 0xff) throw new Error(`data-sources: MySQL query rejected: ${row.toString('utf8')}`); let cursor = 0; const values: unknown[] = []; for (let i = 0; i < expectedColumns; i++) { if (row[cursor] === 0xfb) { values.push(null); cursor++; continue } const [n, nextAt] = readLen(row, cursor); values.push(row.toString('utf8', nextAt, nextAt + n)); cursor = nextAt + n } const size = Buffer.byteLength(JSON.stringify(values)); if (rows.length >= maxRows || emittedBytes + size > maxBytes) { truncated = true; socket.destroy(); break } rows.push(values); emittedBytes += size }
      return { columns, rows, truncated }
    } finally { clearTimeout(deadline); socket.end() }
  }
}

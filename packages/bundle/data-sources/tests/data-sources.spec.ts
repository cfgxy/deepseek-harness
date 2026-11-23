import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config as BundleConfig, DataSourcesRemote } from '../src/index.ts'
import { LocalDirectoryConnector } from '../src/local-directory.ts'
import { MysqlConnector } from '../src/mysql.ts'
import { S3Connector } from '../src/s3.ts'
import { PostgreSqlConnector } from '../src/postgresql.ts'
import { ConnectorSupervisor, type ConnectorRequest, type ReadConnector } from '../src/supervisor.ts'
import type { ReadOperation, SourceConfig, SourceKind } from '../src/types.ts'

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'mysql', 'postgresql']
const execFileAsync = promisify(execFile)

function source(kind: SourceKind): SourceConfig {
  const connection = kind === 's3'
    ? { endpoint: 'http://127.0.0.1:9000', bucket: 'fixture' }
    : kind === 'sftp'
      ? { host: '127.0.0.1', knownHostsPath: '/tmp/known_hosts' }
      : kind === 'mysql' || kind === 'postgresql'
        ? { host: '127.0.0.1', database: 'fixture' }
        : undefined
  return {
    id: kind.replace('-', '_'),
    revision: '1',
    kind,
    label: `${kind} fixture`,
    enabled: true,
    ...(kind === 'local-directory' ? {} : { credentialRef: 'DATA_SOURCE_TEST' }),
    ...(connection === undefined ? {} : { connection }),
    policy: { maxBytes: 1024, maxRows: 10, ...(kind === 's3' ? { allowedPrefix: 'reports/' } : kind === 'local-directory' || kind === 'sftp' ? { allowedPath: '/fixtures/' } : {}) },
  }
}

function request(kind: SourceKind): { operation: ReadOperation; input: Record<string, unknown> } {
  if (kind === 'local-directory' || kind === 'sftp') return { operation: 'directory.list', input: { path: '/fixtures/' } }
  if (kind === 's3') return { operation: 'object.read', input: { path: 'reports/example.csv' } }
  return { operation: 'sql.query', input: { sql: 'SELECT 1' } }
}

function connector(kind: SourceKind): ReadConnector {
  return {
    kind,
    async probe(_input) {},
    async execute(input: ConnectorRequest) {
      return {
        data: {
          kind,
          operation: input.request.operation,
          credentialUsed: input.credential !== undefined,
          maxBytes: input.request.maxBytes,
          maxRows: input.request.maxRows,
        },
        truncated: false,
      }
    },
  }
}

function mysqlPacket(payload: Buffer, sequence: number): Buffer {
  const header = Buffer.alloc(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = sequence
  return Buffer.concat([header, payload])
}

function mysqlHello(capabilities: number): Buffer {
  const seed = Buffer.from('123456789012345678901')
  const low = Buffer.alloc(2); low.writeUInt16LE(capabilities & 0xffff)
  const high = Buffer.alloc(2); high.writeUInt16LE(capabilities >>> 16)
  const connectionId = Buffer.alloc(4); connectionId.writeUInt32LE(1)
  return Buffer.concat([
    Buffer.from([10]), Buffer.from('8.0.0\0'), connectionId, seed.subarray(0, 8), Buffer.from([0]), low,
    Buffer.from([45]), Buffer.alloc(2), high, Buffer.from([21]), Buffer.alloc(10), seed.subarray(8), Buffer.from('mysql_native_password\0'),
  ])
}

async function selfSigned(root: string): Promise<{ key: string; cert: string }> {
  const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem')
  await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'])
  return { key, cert }
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP port')
    resolve(address.port)
  }))
}

describe('read-only data source supervisor', () => {
  it('exposes a redacted remote probe result backed by the same supervisor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-data-source-remote-'))
    const ctx = new Context()
    try {
      const configured: SourceConfig = {
        ...source('local-directory'), policy: { maxBytes: 10, maxRows: 1, allowedPath: root },
      }
      const remote = new DataSourcesRemote(
        ctx,
        new ConnectorSupervisor([configured], [new LocalDirectoryConnector()], { resolve: async () => undefined }),
      )
      await expect(remote.probe({ sourceId: configured.id }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
        ok: true, source: { id: configured.id, revision: '1' }, connector: 'local-directory',
      })
      await expect(remote.probe({ sourceId: '../secret' }, AbortSignal.timeout(1_000))).resolves.toEqual({ ok: false, message: 'Invalid source identifier.' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains credentialRef when the Loader schema constructs external source configuration', () => {
    const parsed = new BundleConfig({ sources: [{
      ...source('postgresql'), credentialRef: 'DATA_SOURCE_TEST',
    }] })
    expect(parsed.sources[0]?.credentialRef).toBe('DATA_SOURCE_TEST')
  })

  it.each(kinds)('executes the %s fixture read through its matching connector', async (kind) => {
    const resolver = { resolve: vi.fn(async () => ({ value: 'fixture-secret' })) }
    const supervisor = new ConnectorSupervisor([source(kind)], [connector(kind)], resolver)
    const probe = await supervisor.probe(source(kind).id)
    const result = await supervisor.execute({ apiVersion: 'v1', sourceId: source(kind).id, ...request(kind) })

    expect(probe).toMatchObject({ source: { id: source(kind).id, revision: '1' }, connector: kind })

    expect(result.source).toEqual({ id: source(kind).id, revision: '1' })
    expect(result.data).toMatchObject({
      kind,
      credentialUsed: kind !== 'local-directory',
      maxBytes: 1024,
      maxRows: 10,
    })
    expect(result.evidence.connector).toBe(kind)
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })

  it('resolves a credential on every external operation instead of caching it', async () => {
    const resolver = { resolve: vi.fn(async () => ({ value: 'rotated-secret' })) }
    const supervisor = new ConnectorSupervisor([source('s3')], [connector('s3')], resolver)
    const read = { apiVersion: 'v1' as const, sourceId: 's3', ...request('s3') }

    await supervisor.execute(read)
    await supervisor.execute(read)

    expect(resolver.resolve).toHaveBeenCalledTimes(2)
  })

  it.each(['mysql', 'postgresql'] as const)('rejects %s write SQL before it reaches a connector', async (kind) => {
    const execute = vi.fn(connector(kind).execute)
    const resolver = { resolve: vi.fn(async () => ({ value: 'fixture-secret' })) }
    const supervisor = new ConnectorSupervisor([source(kind)], [{ kind, probe: async () => {}, execute }], resolver)

    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: source(kind).id, operation: 'sql.query', input: { sql: 'INSERT INTO fixture VALUES (1)' },
    })).rejects.toThrow('only one SELECT')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['local-directory', 'sftp'] as const)('rejects %s normalized paths outside its configured root', async (kind) => {
    const supervisor = new ConnectorSupervisor([source(kind)], [connector(kind)], { resolve: async () => ({ value: 'fixture-secret' }) })
    for (const path of ['/outside/', '/fixtures/../outside/']) {
      await expect(supervisor.execute({
        apiVersion: 'v1', sourceId: source(kind).id, operation: 'directory.list', input: { path },
      })).rejects.toThrow('outside source')
    }
  })

  it('rejects S3 prefix traversal', async () => {
    const supervisor = new ConnectorSupervisor([source('s3')], [connector('s3')], { resolve: async () => ({ value: 'fixture-secret' }) })
    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: 's3', operation: 'object.read', input: { path: 'reports/../private.csv' },
    })).rejects.toThrow('outside source')
  })

  it('permits a local child path when the configured root is slash', async () => {
    const root = { ...source('local-directory'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/' } }
    const supervisor = new ConnectorSupervisor([root], [connector('local-directory')], { resolve: async () => undefined })
    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: root.id, operation: 'directory.list', input: { path: '/fixtures/allowed/' },
    })).resolves.toMatchObject({ data: { kind: 'local-directory' } })
  })

  it.each(['INTO OUTFILE', 'INTO DUMPFILE'])('rejects MySQL SELECT %s writes before connector dispatch', async (clause) => {
    const execute = vi.fn(connector('mysql').execute)
    const supervisor = new ConnectorSupervisor([source('mysql')], [{ kind: 'mysql', probe: async () => {}, execute }], {
      resolve: async () => ({ value: 'fixture-secret' }),
    })
    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: 'mysql', operation: 'sql.query', input: { sql: `SELECT 1 ${clause} '/tmp/fixture'` },
    })).rejects.toThrow('only one SELECT')
    expect(execute).not.toHaveBeenCalled()
  })

  it('bounds real local reads and rejects a symlink which escapes the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-data-sources-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-data-sources-outside-'))
    try {
      await writeFile(join(root, 'report.txt'), 'abcdef')
      await mkdir(join(root, 'nested'))
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(outside, join(root, 'escape'))
      const local: SourceConfig = {
        ...source('local-directory'),
        policy: { maxBytes: 3, maxRows: 10, allowedPath: root },
      }
      const supervisor = new ConnectorSupervisor([local], [new LocalDirectoryConnector()], { resolve: async () => undefined })

      await expect(supervisor.execute({
        apiVersion: 'v1', sourceId: local.id, operation: 'object.read', input: { path: join(root, 'report.txt') },
      })).resolves.toMatchObject({ data: { content: 'abc', bytes: 3 }, truncated: true })
      await expect(supervisor.execute({
        apiVersion: 'v1', sourceId: local.id, operation: 'object.read', input: { path: join(root, 'escape', 'secret.txt') },
      })).rejects.toThrow('escapes')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects an oversized PostgreSQL frame before its body is materialized', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        const header = Buffer.alloc(5)
        header[0] = 'R'.charCodeAt(0)
        header.writeUInt32BE(1024 * 1024 + 5, 1)
        socket.write(header)
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP port')
    try {
      const postgres: SourceConfig = {
        ...source('postgresql'),
        connection: { host: '127.0.0.1', port: address.port, database: 'fixture', timeoutMs: 1_000 },
      }
      await expect(new PostgreSqlConnector().probe({ source: postgres, credential: JSON.stringify({ username: 'fixture' }) }))
        .rejects.toThrow('protocol message exceeds the memory limit')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('refuses MySQL TLS downgrade when the server did not negotiate TLS', async () => {
    const server = createServer(socket => socket.end(mysqlPacket(mysqlHello(0x00000200 | 0x00008000 | 0x00080000), 0)))
    const port = await listen(server)
    try {
      const mysql: SourceConfig = {
        ...source('mysql'),
        connection: { host: '127.0.0.1', port, database: 'fixture', timeoutMs: 1_000, tls: { serverName: 'localhost' } },
      }
      await expect(new MysqlConnector().probe({ source: mysql, credential: JSON.stringify({ username: 'fixture', password: 'fixture' }) }))
        .rejects.toThrow('does not support required TLS')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('uses platform HTTPS certificate validation for S3 endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-s3-tls-'))
    const { key, cert } = await selfSigned(root)
    const [keyPem, certPem] = await Promise.all([readFile(key), readFile(cert)])
    let handled = false
    const server = https.createServer({ key: keyPem, cert: certPem }, (_request, response) => { handled = true; response.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no HTTPS port')
    try {
      const s3: SourceConfig = {
        ...source('s3'),
        connection: { endpoint: `https://127.0.0.1:${address.port}`, bucket: 'fixture' },
      }
      await expect(new S3Connector().probe({ source: s3, credential: JSON.stringify({ accessKeyId: 'fixture', secretAccessKey: 'fixture' }) }))
        .rejects.toThrow('fetch failed')
      expect(handled).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a self-signed PostgreSQL TLS peer instead of permitting certificate bypass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-postgres-tls-'))
    const { key, cert } = await selfSigned(root)
    const [keyPem, certPem] = await Promise.all([readFile(key), readFile(cert)])
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write('S')
        const secure = new tls.TLSSocket(socket, { isServer: true, key: keyPem, cert: certPem })
        secure.on('error', () => {})
      })
    })
    const port = await listen(server)
    try {
      const postgres: SourceConfig = {
        ...source('postgresql'),
        connection: { host: '127.0.0.1', port, database: 'fixture', timeoutMs: 1_000, tls: { serverName: 'localhost' } },
      }
      await expect(new PostgreSqlConnector().probe({ source: postgres, credential: JSON.stringify({ username: 'fixture' }) }))
        .rejects.toThrow(/self-signed|certificate/i)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a source-kind operation that could imply a write-capable adapter command', async () => {
    const supervisor = new ConnectorSupervisor([source('s3')], [connector('s3')], { resolve: async () => ({ value: 'fixture-secret' }) })
    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: 's3', operation: 'sql.query', input: { sql: 'SELECT 1' },
    })).rejects.toThrow('not permitted')
  })
})

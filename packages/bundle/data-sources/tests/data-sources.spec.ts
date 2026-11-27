import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Config as BundleConfig, DataSourcesRemote } from '../src/index.ts'
import * as DataSources from '../src/index.ts'
import { DataSourcesBroker } from '../src/broker.ts'
import { LocalDirectoryConnector } from '../src/local-directory.ts'
import { MysqlConnector } from '../src/mysql.ts'
import { S3Connector } from '../src/s3.ts'
import { SftpConnector } from '../src/sftp.ts'
import { FtpConnector } from '../src/ftp.ts'
import { WebDavConnector } from '../src/webdav.ts'
import { MountedDirectoryConnector } from '../src/mounted-directory.ts'
import { PostgreSqlConnector } from '../src/postgresql.ts'
import { ConnectorSupervisor, type ConnectorRequest, type ReadConnector } from '../src/supervisor.ts'
import { assertSourceConfig, type ReadOperation, type SourceConfig, type SourceKind } from '../src/types.ts'

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'smb', 'nfs', 'ftp', 'webdav', 'mysql', 'postgresql']
const execFileAsync = promisify(execFile)

function source(kind: SourceKind): SourceConfig {
  const connection = kind === 's3'
    ? { endpoint: 'http://127.0.0.1:9000', bucket: 'fixture' }
    : kind === 'sftp'
      ? { host: '127.0.0.1', knownHostsPath: '/tmp/known_hosts' }
      : kind === 'ftp'
        ? { host: '127.0.0.1' }
        : kind === 'webdav'
          ? { endpoint: 'https://127.0.0.1:9001' }
          : kind === 'mysql' || kind === 'postgresql'
            ? { host: '127.0.0.1', database: 'fixture' }
            : undefined
  return {
    id: kind.replace('-', '_'),
    revision: '1',
    kind,
    label: `${kind} fixture`,
    enabled: true,
    ...(kind === 'local-directory' || kind === 'smb' || kind === 'nfs' ? {} : { credentialRef: 'DATA_SOURCE_TEST' }),
    ...(connection === undefined ? {} : { connection }),
    policy: { maxBytes: 1024, maxRows: 10, ...(kind === 's3' ? { allowedPrefix: 'reports/' } : kind === 'local-directory' || kind === 'sftp' || kind === 'smb' || kind === 'nfs' || kind === 'ftp' || kind === 'webdav' ? { allowedPath: '/fixtures/' } : {}) },
  }
}

function request(kind: SourceKind): { operation: ReadOperation; input: Record<string, unknown> } {
  if (kind === 'local-directory' || kind === 'sftp' || kind === 'smb' || kind === 'nfs' || kind === 'ftp' || kind === 'webdav') return { operation: 'directory.list', input: { path: '/fixtures/' } }
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

function brokerRequest(endpoint: { transport: 'unix'; path: string } | { transport: 'tcp'; host: string; port: number }, frame: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = endpoint.transport === 'unix' ? createConnection(endpoint.path) : createConnection(endpoint.port, endpoint.host)
    let response = ''
    socket.setEncoding('utf8'); socket.on('data', (value) => { response += value })
    socket.once('error', reject); socket.once('close', () => resolve(response))
    socket.once('connect', () => socket.end(`${JSON.stringify(frame)}\n`))
  })
}

function dribble(endpoint: { transport: 'unix'; path: string } | { transport: 'tcp'; host: string; port: number }): Promise<void> {
  return new Promise((resolve) => {
    const socket = endpoint.transport === 'unix' ? createConnection(endpoint.path) : createConnection(endpoint.port, endpoint.host)
    socket.once('error', () => resolve()); socket.once('close', () => resolve())
    socket.once('connect', () => { socket.write('{'); setTimeout(() => socket.write('"'), 20) })
  })
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

  it('lists, saves, and deletes credentials via DataSourcesRemote with validation', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'dsh-data-source-creds-'))
    const oldDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = tempHome
    const ctx = new Context()
    const stored = new Map<string, string>()
    ctx.provide('credentials', {
      resolve: async () => undefined,
      describe: async (ref: string) => ({
        configured: stored.has(ref) || ref === 'EXISTING_REF',
        source: 'local',
        writable: true,
      }),
      set: async (ref: string, value: string) => {
        stored.set(ref, value)
      },
      unset: async (ref: string) => {
        stored.delete(ref)
      },
    } as never)

    try {
      await writeFile(join(tempHome, '.credentials.yaml'), 'version: 1\nrefs:\n  EXISTING_REF: "secret"\n')
      const configured: SourceConfig = {
        ...source('mysql'),
        credentialRef: 'ACTIVE_DB_REF',
      }
      const remote = new DataSourcesRemote(
        ctx,
        new ConnectorSupervisor([configured], [connector('mysql')], { resolve: async () => undefined }),
      )

      // listCredentials includes .credentials.yaml refs and supervisor credential refs
      const listRes = await remote.listCredentials(AbortSignal.timeout(1_000))
      expect(listRes.ok).toBe(true)
      expect(listRes.credentials.some(c => c.ref === 'EXISTING_REF')).toBe(true)
      expect(listRes.credentials.some(c => c.ref === 'ACTIVE_DB_REF')).toBe(true)

      // saveCredential validation: invalid ref name
      const invalidRefRes = await remote.saveCredential({ ref: '123_INVALID', value: 'foo' }, AbortSignal.timeout(1_000))
      expect(invalidRefRes.ok).toBe(false)
      expect(invalidRefRes.message).toContain('必须由英文字母')

      // saveCredential validation: empty value
      const emptyValRes = await remote.saveCredential({ ref: 'VALID_REF', value: '' }, AbortSignal.timeout(1_000))
      expect(emptyValRes.ok).toBe(false)
      expect(emptyValRes.message).toContain('不能为空')

      // saveCredential success
      const saveRes = await remote.saveCredential({ ref: 'VALID_REF', value: '{"secret":"123"}' }, AbortSignal.timeout(1_000))
      expect(saveRes.ok).toBe(true)
      expect(stored.get('VALID_REF')).toBe('{"secret":"123"}')

      // deleteCredential validation: invalid ref
      const deleteInvalid = await remote.deleteCredential({ ref: '123_INVALID' }, AbortSignal.timeout(1_000))
      expect(deleteInvalid.ok).toBe(false)

      // deleteCredential success
      const deleteRes = await remote.deleteCredential({ ref: 'VALID_REF' }, AbortSignal.timeout(1_000))
      expect(deleteRes.ok).toBe(true)
      expect(stored.has('VALID_REF')).toBe(false)
    } finally {
      if (oldDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldDshHome
      await ctx.fiber.dispose()
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('projects source inspection without connection coordinates or allowed roots', () => {
    const configured: SourceConfig = {
      ...source('s3'), credentialRef: 'DATA_SOURCE_TEST',
      connection: { endpoint: 'https://internal.invalid', bucket: 'private' },
      policy: { maxBytes: 1024, maxRows: 10, allowedPrefix: 'private/' },
    }
    const supervisor = new ConnectorSupervisor([configured], [connector('s3')], { resolve: async () => undefined })
    const text = JSON.stringify(supervisor.inspect(configured.id))
    expect(text).toContain('maxBytes')
    expect(text).not.toContain('allowedPath')
    expect(text).not.toContain('allowedPrefix')
    expect(text).not.toContain('private/')
    expect(text).not.toContain('internal.invalid')
    expect(text).not.toContain('DATA_SOURCE_TEST')
  })

  it('starts the frozen Python MCP child through the Host and projects brokered results', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    let dataSources: ReturnType<typeof ctx.plugin> | undefined
    try {
      dataSources = ctx.plugin(DataSources, { sources: [source('local-directory')] })
      await dataSources
      const listName = 'mcp__data-sources-python__source_list'
      const infoName = 'mcp__data-sources-python__source_info'
      const deniedName = 'mcp__data-sources-python__data_read'
      expect(ctx.tools.get(listName)).toBeDefined()
      const list = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('data-list'), name: listName, arguments: {} })
      expect(JSON.stringify(list)).toContain('local_directory')
      expect(list.isError).toBe(false)
      const info = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('data-info'), name: infoName, arguments: { source_id: 'local_directory' } })
      expect(info.isError).toBe(false)
      expect(JSON.stringify(info)).toContain('maxBytes')
      expect(JSON.stringify(info)).not.toContain('/fixtures/')
      const denied = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('data-denied'), name: deniedName, arguments: { source_id: 'local_directory', object_id: 'opaque-1' } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('broker rejected the operation')
      expect(JSON.stringify(denied)).not.toContain('/fixtures/')
      await dataSources.dispose()
      dataSources = undefined
      expect(ctx.tools.get(listName)).toBeUndefined()
      expect(ctx.tools.get(infoName)).toBeUndefined()
      expect(ctx.tools.get(deniedName)).toBeUndefined()
    } finally {
      await dataSources?.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('admits Host-owned local file tokens through the managed Python MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-data-sources-file-mcp-'))
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor)
    let dataSources: ReturnType<typeof ctx.plugin> | undefined
    try {
      await writeFile(join(root, 'report.txt'), 'fixture-content')
      const configured: SourceConfig = { ...source('local-directory'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: root } }
      dataSources = ctx.plugin(DataSources, { sources: [configured] })
      await dataSources
      const prefix = 'mcp__data-sources-python__'
      const search = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('file-search'), name: `${prefix}file_search`, arguments: { source_id: configured.id, query: 'report' } })
      expect(search.isError).toBe(false)
      const searchValue = search.value as { content: { type: string; text?: string }[] }
      const found = JSON.parse(searchValue.content.find(block => block.type === 'text')!.text!) as { objects: { object_id: string }[] }
      expect(found.objects).toHaveLength(1)
      expect(JSON.stringify(search)).not.toContain(root)
      const read = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('file-read'), name: `${prefix}data_read`, arguments: { source_id: configured.id, object_id: found.objects[0]!.object_id } })
      expect(read.isError).toBe(false)
      expect(JSON.stringify(read)).toContain('fixture-content')
      expect(JSON.stringify(read)).not.toContain(root)
      const rawPath = await executeToolFixture(ctx, { signal: AbortSignal.timeout(10_000), callId: ToolCallId('raw-path'), name: `${prefix}data_read`, arguments: { source_id: configured.id, object_id: join(root, 'report.txt') } })
      expect(rawPath.isError).toBe(true)
      expect(JSON.stringify(rawPath)).not.toContain(root)
    } finally {
      await dataSources?.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rolls back the broker and tool generation when the Python child cannot start', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    try {
      await ctx.plugin(DataSources, { pythonCommand: process.execPath, sources: [source('local-directory')] })
      expect(ctx.tools.get('mcp__data-sources-python__source_list')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('declares source definitions as one live-editable settings field', () => {
    expect(BundleConfig.dict?.sources?.meta.volatile).toBe(true)
  })

  it('retains credentialRef when the Loader schema constructs external source configuration', () => {
    const parsed = new BundleConfig({ sources: [{
      ...source('postgresql'), credentialRef: 'DATA_SOURCE_TEST',
    }] })
    const configured = parsed.sources.get()[0]
    expect(configured?.credentialRef).toBe('DATA_SOURCE_TEST')
    expect(configured?.connection?.tls?.enabled).toBeUndefined()
    expect(() => assertSourceConfig(configured!)).not.toThrow()
  })

  it('keeps TLS opt-in and retains numeric deadline validation', () => {
    expect(() => assertSourceConfig({
      ...source('postgresql'), connection: { host: '127.0.0.1', database: 'fixture', timeoutMs: 0 },
    })).toThrow('invalid timeoutMs')
    expect(() => assertSourceConfig({
      ...source('s3'), connection: { endpoint: 'https://example.invalid', bucket: 'fixture', tls: { enabled: true } },
    })).toThrow('TLS is supported only for database connectors')
  })

  it('rejects invalid FTP and WebDAV connection coordinates before connector dispatch', () => {
    expect(() => { assertSourceConfig({ ...source('ftp'), connection: {}, policy: { maxBytes: 1, maxRows: 1, allowedPath: '/' } }) }).toThrow('valid host')
    expect(() => { assertSourceConfig({ ...source('ftp'), connection: { host: 'fixture\nlogin injected' }, policy: { maxBytes: 1, maxRows: 1, allowedPath: '/' } }) }).toThrow('valid host')
    expect(() => { assertSourceConfig({ ...source('webdav'), connection: { endpoint: 'http://example.invalid' }, policy: { maxBytes: 1, maxRows: 1, allowedPath: '/' } }) }).toThrow('invalid WebDAV endpoint')
    expect(() => { assertSourceConfig({ ...source('webdav'), connection: { endpoint: 'https://user:secret@example.invalid' }, policy: { maxBytes: 1, maxRows: 1, allowedPath: '/' } }) }).toThrow('invalid WebDAV endpoint')
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
      credentialUsed: !['local-directory', 'smb', 'nfs'].includes(kind),
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

  it.each(['local-directory', 'sftp', 'smb', 'nfs', 'ftp', 'webdav'] as const)('rejects %s normalized paths outside its configured root', async (kind) => {
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

  it.each(['unix', 'tcp'] as const)('enforces bounded authenticated broker frames over %s', async (transport) => {
    const responseOverhead = Buffer.byteLength(JSON.stringify({ ok: true, result: { value: '' } }))
    let aborted = false
    const broker = new DataSourcesBroker(async (request, signal) => {
      if (request.operation === 'boundary') return { value: 'x'.repeat(64 * 1024 - 1 - responseOverhead) }
      if (request.operation === 'boundary-over') return { value: 'x'.repeat(64 * 1024 - responseOverhead) }
      if (request.operation === 'reject') throw new Error('private detail')
      if (request.operation === 'slow') return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true }))
      return { operation: request.operation }
    }, { transport, deadlineMs: 40 })
    const bootstrap = await broker.start()
    try {
      await expect(brokerRequest(bootstrap.endpoint, { capability: 'wrong', operation: 'source_list', arguments: {} }))
        .resolves.toBe('{"ok":false}\n')
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'source_list', arguments: {} }))
        .resolves.toBe('{"ok":true,"result":{"operation":"source_list"}}\n')
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'boundary', arguments: {} }))
        .resolves.toSatisfy((response: string) => Buffer.byteLength(response) === 64 * 1024 && response.endsWith('\n'))
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'boundary-over', arguments: {} }))
        .resolves.toBe('{"ok":false}\n')
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'reject', arguments: {} }))
        .resolves.toBe('{"ok":false}\n')
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'x', arguments: { oversized: 'x'.repeat(65 * 1024) } }))
        .resolves.toBe('')
      await expect(dribble(bootstrap.endpoint)).resolves.toBeUndefined()
      await expect(brokerRequest(bootstrap.endpoint, { capability: bootstrap.capability, operation: 'slow', arguments: {} })).resolves.toBe('')
      expect(aborted).toBe(true)
    } finally { await broker.dispose() }
  })

  it.each(['smb', 'nfs'] as const)('reads only through the configured %s mount root', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-${kind}-`))
    const outside = await mkdtemp(join(tmpdir(), `dsh-${kind}-outside-`))
    try {
      await writeFile(join(root, 'report.txt'), 'mounted-content')
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(outside, join(root, 'escape'))
      const configured: SourceConfig = { ...source(kind), policy: { maxBytes: 1_024, maxRows: 10, allowedPath: root } }
      const supervisor = new ConnectorSupervisor([configured], [new MountedDirectoryConnector(kind)], { resolve: async () => undefined })
      await expect(supervisor.probe(configured.id)).resolves.toMatchObject({ connector: kind })
      const files = await supervisor.listFiles(configured.id)
      expect(files.objects).toHaveLength(1)
      await expect(supervisor.readFile(configured.id, files.objects[0]!.object_id, 8)).resolves.toMatchObject({ data: { content: 'mounted-', bytes: 8 }, truncated: true })
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'object.read', input: { path: join(root, 'escape', 'secret.txt') } })).rejects.toThrow('escapes')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('serializes FTP credentials losslessly over the real control channel', async () => {
    const commands: string[] = []
    let authenticated: () => void = () => {}
    const authentication = new Promise<void>((resolve) => { authenticated = resolve })
    const server = createServer((socket) => {
      let pending = Buffer.alloc(0)
      socket.write('220 test FTP server\r\n')
      socket.on('data', (data: Buffer) => {
        pending = Buffer.concat([pending, data])
        for (;;) {
          const boundary = pending.indexOf('\r\n')
          if (boundary === -1) return
          const command = pending.subarray(0, boundary).toString('utf8')
          pending = pending.subarray(boundary + 2)
          commands.push(command)
          if (command.startsWith('USER ')) socket.write('331 password required\r\n')
          else if (command.startsWith('PASS ')) {
            socket.write('230 authenticated\r\n')
            socket.end()
            authenticated()
          }
        }
      })
    })
    const port = await listen(server)
    const username = 'alice password "quoted"\\literal'
    const password = 'actual secret "quoted"\\literal'
    const ftp: SourceConfig = {
      ...source('ftp'),
      connection: { host: '127.0.0.1', port, timeoutMs: 1_000 },
      policy: { maxBytes: 1_024, maxRows: 10, allowedPath: '/' },
    }
    try {
      const supervisor = new ConnectorSupervisor(
        [ftp], [new FtpConnector()],
        { resolve: async () => ({ value: JSON.stringify({ username, password }) }) },
      )
      await expect(supervisor.probe(ftp.id)).rejects.toThrow('FTP operation failed')
      await authentication
      expect(commands.slice(0, 2)).toEqual([`USER ${username}`, `PASS ${password}`])
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('stops FTP object and directory output streams at their byte or row sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ftp-stream-'))
    const curl = join(root, 'curl')
    const originalPath = process.env.PATH
    try {
      await writeFile(curl, '#!/bin/sh\ncase " $* " in *" --list-only "*) while :; do printf "entry\\n"; done ;; *) while :; do printf x; done ;; esac\n', { mode: 0o755 })
      process.env.PATH = `${root}:${originalPath ?? ''}`
      const ftp: SourceConfig = { ...source('ftp'), connection: { host: 'fixture', timeoutMs: 1_000 }, policy: { maxBytes: 32, maxRows: 1, allowedPath: '/' } }
      const credential = JSON.stringify({ username: 'fixture', password: 'fixture' })
      await expect(new FtpConnector().execute({ source: ftp, credential, request: { apiVersion: 'v1', sourceId: ftp.id, operation: 'object.read', input: { path: '/object' }, maxBytes: 4, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { content: 'xxxx', bytes: 4 }, truncated: true })
      await expect(new FtpConnector().execute({ source: ftp, credential, request: { apiVersion: 'v1', sourceId: ftp.id, operation: 'directory.list', input: { path: '/' }, maxBytes: 32, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { entries: ['entry'] }, truncated: true })
    } finally {
      process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses read-only authenticated WebDAV methods and caps their output', async () => {
    let observed: { method?: string | undefined; authorization?: string | undefined; range?: string | undefined } = {}
    const server = createHttpServer((request, response) => {
      observed = { method: request.method, authorization: request.headers.authorization, range: request.headers.range }
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'content-type': 'application/xml' })
        response.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/fixtures/</d:href></d:response><d:response><d:href>/fixtures/alpha.txt</d:href></d:response><d:response><d:href>/fixtures/beta.txt</d:href></d:response></d:multistatus>')
        return
      }
      response.end('abcde')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no HTTP port')
    try {
      const webdav: SourceConfig = { ...source('webdav'), connection: { endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 1_000 }, policy: { maxBytes: 1_024, maxRows: 1, allowedPath: '/fixtures' } }
      const credential = JSON.stringify({ username: 'fixture', password: 'secret' })
      await expect(new WebDavConnector().execute({ source: webdav, credential, request: { apiVersion: 'v1', sourceId: webdav.id, operation: 'directory.list', input: { path: '/fixtures' }, maxBytes: 1_024, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { entries: ['alpha.txt'] }, truncated: true })
      expect(observed).toMatchObject({ method: 'PROPFIND', authorization: `Basic ${Buffer.from('fixture:secret').toString('base64')}` })
      await expect(new WebDavConnector().execute({ source: webdav, credential, request: { apiVersion: 'v1', sourceId: webdav.id, operation: 'object.read', input: { path: '/fixtures/alpha.txt' }, maxBytes: 4, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { content: 'abcd', bytes: 4 }, truncated: true })
      expect(observed).toMatchObject({ method: 'GET', range: 'bytes=0-4' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })

  it('bounds real local reads and rejects a symlink which escapes the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-data-sources-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-data-sources-outside-'))
    try {
      await writeFile(join(root, 'report.txt'), 'abcdef')
      await writeFile(join(root, 'entry-a'), 'a')
      await writeFile(join(root, 'entry-b'), 'b')
      await mkdir(join(root, 'nested'))
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(outside, join(root, 'escape'))
      const local: SourceConfig = {
        ...source('local-directory'),
        policy: { maxBytes: 3, maxRows: 10, allowedPath: root },
      }
      const supervisor = new ConnectorSupervisor([local], [new LocalDirectoryConnector()], { resolve: async () => undefined })

      await expect(supervisor.execute({
        apiVersion: 'v1', sourceId: local.id, operation: 'directory.list', input: { path: root }, maxRows: 1,
      })).resolves.toMatchObject({ data: [], truncated: true })
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

  it('stops SFTP object and directory output streams at their byte or row sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sftp-stream-'))
    const privateKey = join(root, 'private')
    const knownHosts = join(root, 'known_hosts')
    const curl = join(root, 'curl')
    const originalPath = process.env.PATH
    try {
      await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey])
      await writeFile(knownHosts, `fixture ${await readFile(`${privateKey}.pub`, 'utf8')}`)
      await writeFile(curl, '#!/bin/sh\ncase " $* " in *" --list-only "*) while :; do printf "entry\\n"; done ;; *) while :; do printf x; done ;; esac\n', { mode: 0o755 })
      process.env.PATH = `${root}:${originalPath ?? ''}`
      const sftp: SourceConfig = {
        ...source('sftp'), connection: { host: 'fixture', knownHostsPath: knownHosts, timeoutMs: 1_000 },
        policy: { maxBytes: 32, maxRows: 1, allowedPath: '/' },
      }
      const credential = JSON.stringify({ username: 'fixture', privateKey: await readFile(privateKey, 'utf8') })
      await expect(new SftpConnector().execute({ source: sftp, credential, request: { apiVersion: 'v1', sourceId: sftp.id, operation: 'object.read', input: { path: '/object' }, maxBytes: 4, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { content: 'xxxx', bytes: 4 }, truncated: true })
      await expect(new SftpConnector().execute({ source: sftp, credential, request: { apiVersion: 'v1', sourceId: sftp.id, operation: 'directory.list', input: { path: '/' }, maxBytes: 32, maxRows: 1 } }))
        .resolves.toMatchObject({ data: { entries: ['entry'] }, truncated: true })
    } finally {
      process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits file reads only through opaque Host-minted catalog tokens', async () => {
    const local: SourceConfig = {
      ...source('local-directory'),
      policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/fixtures' },
    }
    const execute = vi.fn(async ({ request }: ConnectorRequest) => {
      if (request.operation === 'directory.list') return { data: [{ name: 'report.txt', kind: 'file' }], truncated: false }
      expect(request.input).toEqual({ path: '/fixtures/report.txt' })
      return { data: { path: '/fixtures/report.txt', bytes: 2, content: 'ok' }, truncated: false }
    })
    const supervisor = new ConnectorSupervisor([local], [{ kind: 'local-directory', probe: async () => {}, execute }], { resolve: async () => undefined })
    const listed = await supervisor.listFiles(local.id, 'report')
    expect(listed.objects).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('/fixtures')
    const read = await supervisor.readFile(local.id, listed.objects[0]!.object_id)
    expect(read).toMatchObject({ data: { bytes: 2, content: 'ok' }, truncated: false })
    expect(JSON.stringify(read)).not.toContain('/fixtures')
    await expect(supervisor.readFile(local.id, 'forged-token')).rejects.toThrow('not admitted')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    { kind: 's3' as const, source: { ...source('s3'), policy: { maxBytes: 1024, maxRows: 10, allowedPrefix: 'reports/' } }, catalog: { keys: ['reports/report.txt'] }, expected: 'reports/report.txt' },
    { kind: 'sftp' as const, source: { ...source('sftp'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/upload' } }, catalog: { entries: ['report.txt'] }, expected: '/upload/report.txt' },
    { kind: 'smb' as const, source: { ...source('smb'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/upload' } }, catalog: [{ name: 'report.txt', kind: 'file' }], expected: '/upload/report.txt' },
    { kind: 'nfs' as const, source: { ...source('nfs'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/upload' } }, catalog: [{ name: 'report.txt', kind: 'file' }], expected: '/upload/report.txt' },
    { kind: 'ftp' as const, source: { ...source('ftp'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/upload' } }, catalog: { entries: ['report.txt'] }, expected: '/upload/report.txt' },
    { kind: 'webdav' as const, source: { ...source('webdav'), policy: { maxBytes: 1024, maxRows: 10, allowedPath: '/upload' } }, catalog: { entries: ['report.txt'] }, expected: '/upload/report.txt' },
  ])('normalizes listed $kind objects before a token can read them', async ({ kind, source: configured, catalog, expected }) => {
    const execute = vi.fn(async ({ request }: ConnectorRequest) => {
      if (request.operation === 'catalog' || request.operation === 'directory.list') return { data: catalog, truncated: false }
      expect(request.input).toEqual({ path: expected })
      return { data: { path: expected, bytes: 2, content: 'ok' }, truncated: false }
    })
    const supervisor = new ConnectorSupervisor([configured], [{ kind, probe: async () => {}, execute }], { resolve: async () => ({ value: 'fixture' }) })
    const listed = await supervisor.listFiles(configured.id)
    expect(listed.objects).toHaveLength(1)
    await expect(supervisor.readFile(configured.id, listed.objects[0]!.object_id)).resolves.toMatchObject({ data: { content: 'ok' } })
    expect(JSON.stringify(listed)).not.toContain(expected)
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
        connection: { host: '127.0.0.1', port, database: 'fixture', timeoutMs: 1_000, tls: { enabled: true, serverName: 'localhost' } },
      }
      await expect(new MysqlConnector().probe({ source: mysql, credential: JSON.stringify({ username: 'fixture', password: 'fixture' }) }))
        .rejects.toThrow('does not support required TLS')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('stops an S3 body after its truncation sentinel and caps catalog keys upstream', async () => {
    const sockets = new Set<import('node:net').Socket>()
    let range: string | undefined; let catalogLimit: string | null = null
    const server = createHttpServer((incoming, response) => {
      const url = new URL(incoming.url!, 'http://fixture.invalid')
      if (url.searchParams.get('list-type') === '2') {
        catalogLimit = url.searchParams.get('max-keys')
        response.write('<ListBucketResult><Key>reports/a</Key><Key>reports/b</Key><Key>reports/c</Key>' + 'x'.repeat(256))
      } else {
        range = incoming.headers.range
        response.write('abcde')
      }
    })
    server.on('connection', socket => sockets.add(socket))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no HTTP port')
    const s3: SourceConfig = {
      ...source('s3'), connection: { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'fixture', timeoutMs: 1_000 },
      policy: { maxBytes: 128, maxRows: 2, allowedPrefix: 'reports/' },
    }
    const credential = JSON.stringify({ accessKeyId: 'fixture', secretAccessKey: 'fixture' })
    try {
      await expect(new S3Connector().execute({ source: s3, credential, request: { apiVersion: 'v1', sourceId: s3.id, operation: 'object.read', input: { path: 'reports/a' }, maxBytes: 4, maxRows: 2 } }))
        .resolves.toMatchObject({ data: { content: 'abcd', bytes: 4 }, truncated: true })
      expect(range).toBe('bytes=0-4')
      await expect(new S3Connector().execute({ source: s3, credential, request: { apiVersion: 'v1', sourceId: s3.id, operation: 'catalog', input: {}, maxBytes: 128, maxRows: 2 } }))
        .resolves.toMatchObject({ data: { keys: ['reports/a', 'reports/b'] }, truncated: true })
      expect(catalogLimit).toBe('3')
    } finally {
      for (const socket of sockets) socket.destroy()
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
        connection: { host: '127.0.0.1', port, database: 'fixture', timeoutMs: 1_000, tls: { enabled: true, serverName: 'localhost' } },
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

  it.each(['local-directory', 'sftp', 'smb', 'nfs', 'ftp', 'webdav'] as const)('normalizes non-root %s allowedPath trailing slashes without relaxing prefix isolation', async (kind) => {
    for (const allowedPath of ['/files/', '/files']) {
      const configured: SourceConfig = { ...source(kind), policy: { maxBytes: 1024, maxRows: 10, allowedPath } }
      const supervisor = new ConnectorSupervisor([configured], [connector(kind)], { resolve: async () => ({ value: 'fixture-secret' }) })
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'directory.list', input: { path: '/files' } })).resolves.toMatchObject({ data: { kind } })
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'directory.list', input: { path: '/files/' } })).resolves.toMatchObject({ data: { kind } })
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'object.read', input: { path: '/files/report.txt' } })).resolves.toMatchObject({ data: { kind } })
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'object.read', input: { path: '/files2/report.txt' } })).rejects.toThrow('outside source')
      await expect(supervisor.execute({ apiVersion: 'v1', sourceId: configured.id, operation: 'object.read', input: { path: '/files/../outside/secret.txt' } })).rejects.toThrow('outside source')
    }
  })

  it('lists and reads non-root FTP subdirectories over real control and data channels regardless of trailing slash', async () => {
    const commands: string[] = []
    const files = new Map<string, string>([['/files/ftp-report.txt', 'ftp-subdir-payload-0123456789']])
    const dataServers = new Set<ReturnType<typeof createServer>>()
    const server = createServer((control) => {
      let pending = Buffer.alloc(0); let cwd = '/'; let dataServer: ReturnType<typeof createServer> | undefined
      let dataSocket: import('node:net').Socket | undefined; let waitingData: ((socket: import('node:net').Socket) => void) | undefined
      const acceptData = () => dataSocket !== undefined ? Promise.resolve(dataSocket) : new Promise<import('node:net').Socket>((resolve) => { waitingData = resolve })
      const closeData = () => { dataSocket?.destroy(); dataSocket = undefined; dataServer?.close(); dataServer = undefined }
      control.on('error', () => {})
      control.on('close', closeData)
      control.write('220 test FTP server\r\n')
      control.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        for (;;) {
          const boundary = pending.indexOf('\r\n')
          if (boundary === -1) return
          const line = pending.subarray(0, boundary).toString('utf8')
          pending = pending.subarray(boundary + 2)
          commands.push(line)
          const space = line.indexOf(' ')
          const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase()
          const arg = space === -1 ? '' : line.slice(space + 1)
          if (verb === 'USER') control.write('331 password required\r\n')
          else if (verb === 'PASS') control.write('230 logged in\r\n')
          else if (verb === 'PWD') control.write(`257 "${cwd}" is current directory\r\n`)
          else if (verb === 'TYPE') control.write('200 Type set\r\n')
          else if (verb === 'QUIT') { control.end('221 Bye\r\n'); closeData() }
          else if (verb === 'CWD') {
            const target = arg.startsWith('/') ? arg : `${cwd === '/' ? '' : cwd}/${arg}`
            const normalized = target.replace(/\/+$/, '') || '/'
            if (normalized === '/' || normalized === '/files') { cwd = normalized; control.write('250 Directory changed\r\n') }
            else control.write('550 No such directory\r\n')
          } else if (verb === 'EPSV') {
            closeData()
            dataServer = createServer((socket) => {
              socket.on('error', () => {})
              dataSocket = socket
              if (waitingData !== undefined) { const resolve = waitingData; waitingData = undefined; resolve(socket) }
            })
            dataServers.add(dataServer)
            dataServer.listen(0, '127.0.0.1', () => {
              const address = dataServer!.address()
              if (address === null || typeof address === 'string') return
              control.write(`229 Entering Extended Passive Mode (|||${address.port}|)\r\n`)
            })
          } else if (verb === 'NLST' || verb === 'LIST') {
            const dir = arg ? (arg.startsWith('/') ? arg : `${cwd === '/' ? '' : cwd}/${arg}`) : cwd
            const normalized = dir.replace(/\/+$/, '') || '/'
            const body = normalized === '/files' ? 'ftp-report.txt\r\n' : normalized === '/' ? 'files\r\n' : ''
            void acceptData().then((socket) => {
              control.write('150 Opening data connection\r\n')
              socket.end(body, () => { control.write('226 Transfer complete\r\n'); closeData() })
            })
          } else if (verb === 'RETR') {
            const target = arg.startsWith('/') ? arg : `${cwd === '/' ? '' : cwd}/${arg}`
            const content = files.get(target)
            if (content === undefined) { control.write('550 File not found\r\n'); closeData() }
            else {
              void acceptData().then((socket) => {
                control.write('150 Opening data connection\r\n')
                socket.end(content, () => { control.write('226 Transfer complete\r\n'); closeData() })
              })
            }
          } else control.write('502 Unsupported\r\n')
        }
      })
    })
    const port = await listen(server)
    try {
      for (const allowedPath of ['/files', '/files/']) {
        commands.length = 0
        const ftp: SourceConfig = {
          ...source('ftp'),
          id: `ftp-${allowedPath === '/files' ? 'plain' : 'slash'}`,
          connection: { host: '127.0.0.1', port, timeoutMs: 3_000 },
          policy: { maxBytes: 1_024, maxRows: 10, allowedPath },
        }
        const supervisor = new ConnectorSupervisor([ftp], [new FtpConnector()], { resolve: async () => ({ value: JSON.stringify({ username: 'fixture', password: 'secret' }) }) })
        await expect(supervisor.probe(ftp.id)).resolves.toMatchObject({ connector: 'ftp' })
        const listed = await supervisor.listFiles(ftp.id)
        expect(listed.objects.map(item => item.name)).toEqual(['ftp-report.txt'])
        expect(commands.some(cmd => cmd === 'CWD files' || cmd === 'CWD /files')).toBe(true)
        const read = await supervisor.readFile(ftp.id, listed.objects[0]!.object_id, 8)
        expect(read).toMatchObject({ data: { bytes: 8, content: 'ftp-subd' }, truncated: true })
      }
    } finally {
      for (const ds of dataServers) ds.close()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
    }
  }, 15_000)
})

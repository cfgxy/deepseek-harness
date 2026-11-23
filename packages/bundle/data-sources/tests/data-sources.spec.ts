import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalDirectoryConnector } from '../src/local-directory.ts'
import { ConnectorSupervisor, type ConnectorRequest, type ReadConnector } from '../src/supervisor.ts'
import type { ReadOperation, SourceConfig, SourceKind } from '../src/types.ts'

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'mysql', 'postgresql']

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

describe('read-only data source supervisor', () => {
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

  it('rejects a source-kind operation that could imply a write-capable adapter command', async () => {
    const supervisor = new ConnectorSupervisor([source('s3')], [connector('s3')], { resolve: async () => ({ value: 'fixture-secret' }) })
    await expect(supervisor.execute({
      apiVersion: 'v1', sourceId: 's3', operation: 'sql.query', input: { sql: 'SELECT 1' },
    })).rejects.toThrow('not permitted')
  })
})

import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as DataSources from '../src/index.ts'
import type { SourceConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const MYSQL_IMAGE = 'mysql@sha256:8c233bad33d520a7aae1c1e619c3a9775f4a1ba2d463d692fada04ec7f40be00'
const POSTGRES_IMAGE = 'postgres@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8'
const fixturePassword = 'data-sources-fixture-password'
const descriptorSentinel = 'data-sources-descriptor-sentinel'

interface Fixture { mysql: string; postgres: string; mysqlPort: number; postgresPort: number; root: string }

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args)
  return stdout.trim()
}

async function port(container: string, containerPort: string): Promise<number> {
  const output = await run('docker', ['port', container, containerPort])
  const match = output.match(/:(\d+)$/m)
  if (match === null) throw new Error('fixture port is unavailable')
  return Number(match[1])
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 60_000
  let failure: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 300)) }
  }
  throw failure
}

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-data-sources-mcp-'))
  const suffix = `${process.pid}-${Date.now()}`
  const mysql = `dsh-ds-mysql8-${suffix}`
  const postgres = `dsh-ds-postgres16-${suffix}`
  try {
    await run('docker', ['run', '-d', '--rm', '--name', mysql, '-p', '127.0.0.1::3306', '-e', `MYSQL_ROOT_PASSWORD=${fixturePassword}`, '-e', 'MYSQL_ROOT_HOST=%', '-e', 'MYSQL_DATABASE=fixture', MYSQL_IMAGE])
    await run('docker', ['run', '-d', '--rm', '--name', postgres, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${fixturePassword}`, '-e', 'POSTGRES_DB=fixture', POSTGRES_IMAGE])
    const [mysqlPort, postgresPort] = await Promise.all([port(mysql, '3306/tcp'), port(postgres, '5432/tcp')])
    await eventually(async () => { await run('docker', ['exec', mysql, 'mysqladmin', 'ping', '-h127.0.0.1', '-uroot', `-p${fixturePassword}`, '--silent']) })
    await eventually(async () => { await run('docker', ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'fixture']) })
    await run('docker', ['exec', mysql, 'mysql', '-uroot', `-p${fixturePassword}`, '-e', "CREATE TABLE fixture.orders (join_key INT PRIMARY KEY, mysql_value VARCHAR(32)); INSERT INTO fixture.orders VALUES (1, 'm1'), (2, 'm2')"])
    await run('docker', ['exec', postgres, 'psql', '-U', 'postgres', '-d', 'fixture', '-c', "CREATE TABLE public.sales (join_key INT PRIMARY KEY, postgres_value TEXT); INSERT INTO public.sales VALUES (1, 'p1'), (2, 'p2')"])
    return { mysql, postgres, mysqlPort, postgresPort, root }
  } catch (error) {
    await Promise.allSettled([run('docker', ['rm', '-f', mysql]), run('docker', ['rm', '-f', postgres])])
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function stopFixture(fixture: Fixture | undefined): Promise<void> {
  if (fixture === undefined) return
  await Promise.allSettled([run('docker', ['rm', '-f', fixture.mysql]), run('docker', ['rm', '-f', fixture.postgres])])
  await rm(fixture.root, { recursive: true, force: true })
}

function source(id: string, kind: 'mysql' | 'postgresql', port: number, credentialRef: string, tls = false): SourceConfig {
  return {
    id, revision: 'fixture-v1', kind, label: id, enabled: true, credentialRef,
    connection: { host: '127.0.0.1', port, database: 'fixture', timeoutMs: 10_000, statementTimeoutMs: 5_000, ...(tls ? { tls: { enabled: true, serverName: 'localhost' } } : {}) },
    policy: { maxBytes: 1024, maxRows: 8 },
  }
}

function resultJson(result: Awaited<ReturnType<typeof executeToolFixture>>): unknown {
  if (result.isError) throw new Error(JSON.stringify(result))
  const value = result.value as { content: Array<{ type: string; text?: string }> }
  const text = value.content.find(block => block.type === 'text')?.text
  if (text === undefined) throw new Error('MCP tool did not return text JSON')
  return JSON.parse(text)
}

async function call(ctx: Context, id: string, name: string, arguments_: Record<string, unknown>): Promise<unknown> {
  return resultJson(await executeToolFixture(ctx, {
    signal: AbortSignal.timeout(30_000), callId: ToolCallId(id), name, arguments: arguments_,
  }))
}

function alias(sources: readonly { id: string; queryAlias?: string }[], id: string): string {
  const value = sources.find(source => source.id === id)?.queryAlias
  if (value === undefined) throw new Error('database source alias is unavailable')
  return value
}

describe.skipIf(!dockerAvailable)('managed database MCP fixtures', () => {
  it('discovers listed objects and executes bounded cross-source joins without descriptor leakage', async () => {
    const fixture = await startFixture()
    const ctx = new Context()
    let plugin: ReturnType<typeof ctx.plugin> | undefined
    try {
      ctx.provide('credentials', { resolve: async (ref: string) => ({ value: ref === 'MYSQL_FIXTURE' ? JSON.stringify({ username: 'root', password: fixturePassword }) : ref === 'POSTGRES_FIXTURE' ? JSON.stringify({ username: 'postgres', password: fixturePassword }) : descriptorSentinel }) } as never)
      await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor)
      const mysqlId = 'mysql-source-8'
      const postgresId = 'postgres-source-16'
      plugin = ctx.plugin(DataSources, { sources: [source(mysqlId, 'mysql', fixture.mysqlPort, 'MYSQL_FIXTURE'), source(postgresId, 'postgresql', fixture.postgresPort, 'POSTGRES_FIXTURE'), source('tls-source', 'mysql', fixture.mysqlPort, 'MYSQL_FIXTURE', true), source('sentinel-source', 'mysql', fixture.mysqlPort, 'SENTINEL_FIXTURE')] })
      await plugin
      const prefix = 'mcp__data-sources-python__'
      const mysqlInfo = await call(ctx, 'mysql-info', `${prefix}source_info`, { source_id: mysqlId }) as { id: string; queryAlias?: string }
      const postgresInfo = await call(ctx, 'postgres-info', `${prefix}source_info`, { source_id: postgresId }) as { id: string; queryAlias?: string }
      const mysqlAlias = alias([mysqlInfo], mysqlId); const postgresAlias = alias([postgresInfo], postgresId)
      const mysqlCatalog = await call(ctx, 'mysql-list', `${prefix}data_list`, { source_id: mysqlId }) as { objects: { name: string; object_id: string }[] }
      const postgresCatalog = await call(ctx, 'postgres-list', `${prefix}data_list`, { source_id: postgresId }) as { objects: { name: string; object_id: string }[] }
      const mysqlObject = mysqlCatalog.objects.find(object => object.name === 'orders')
      const postgresObject = postgresCatalog.objects.find(object => object.name === 'sales')
      expect(mysqlObject?.object_id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(postgresObject?.object_id).toMatch(/^[A-Za-z0-9_-]+$/)
      const described = await call(ctx, 'describe', `${prefix}data_describe`, { source_id: mysqlId, object_id: mysqlObject?.object_id }) as { columns: string[] }
      expect(described.columns).toEqual(expect.arrayContaining(['column_name', 'data_type', 'ordinal_position']))
      const query = `SELECT ${mysqlAlias}.fixture.orders.join_key FROM ${mysqlAlias}.fixture.orders JOIN ${postgresAlias}.public.sales ON ${mysqlAlias}.fixture.orders.join_key = ${postgresAlias}.public.sales.join_key`
      const joined = await call(ctx, 'join', `${prefix}data_query`, { source_ids: [mysqlId, postgresId], sql: query }) as { rows: unknown[]; truncated: boolean }
      expect(joined.rows).toHaveLength(2)
      expect(joined.truncated).toBe(false)
      const rowBounded = await call(ctx, 'row-bounded', `${prefix}data_query`, { source_ids: [mysqlId, postgresId], sql: query, max_rows: 1 }) as { rows: unknown[]; truncated: boolean }
      expect(rowBounded.rows).toHaveLength(1)
      expect(rowBounded.truncated).toBe(true)
      const bounded = await call(ctx, 'byte-bounded', `${prefix}data_query`, { source_ids: [mysqlId, postgresId], sql: query, max_rows: 1, max_bytes: 1 }) as { rows: unknown[]; truncated: boolean }
      expect(bounded.rows).toHaveLength(0)
      expect(bounded.truncated).toBe(true)
      const unlisted = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('unlisted'), name: `${prefix}data_query`, arguments: { source_ids: [mysqlId], sql: `SELECT * FROM ${mysqlAlias}.fixture.unlisted` } })
      expect(unlisted.isError).toBe(true)
      const forged = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('forged'), name: `${prefix}data_describe`, arguments: { source_id: mysqlId, object_id: 'forged-object' } })
      expect(forged.isError).toBe(true)
      const wrongSource = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('wrong-source'), name: `${prefix}data_describe`, arguments: { source_id: postgresId, object_id: mysqlObject?.object_id } })
      expect(wrongSource.isError).toBe(true)
      const dangerous = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('dangerous'), name: `${prefix}data_query`, arguments: { source_ids: [mysqlId], sql: `INSERT INTO ${mysqlAlias}.fixture.orders VALUES (3)` } })
      expect(dangerous.isError).toBe(true)
      const tls = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('tls'), name: `${prefix}data_list`, arguments: { source_id: 'tls-source' } })
      expect(tls.isError).toBe(true)
      const sentinel = await executeToolFixture(ctx, { signal: AbortSignal.timeout(30_000), callId: ToolCallId('sentinel'), name: `${prefix}data_list`, arguments: { source_id: 'sentinel-source' } })
      expect(sentinel.isError).toBe(true)
      expect(JSON.stringify(sentinel)).not.toContain(descriptorSentinel)
    } finally {
      await plugin?.dispose()
      await ctx.fiber.dispose()
      await stopFixture(fixture)
    }
  }, 120_000)
})

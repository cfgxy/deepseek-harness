import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import { LocalDirectoryConnector } from './local-directory.ts'
import { S3Connector } from './s3.ts'
import { SftpConnector } from './sftp.ts'
import { FtpConnector } from './ftp.ts'
import { WebDavConnector } from './webdav.ts'
import { MountedDirectoryConnector } from './mounted-directory.ts'
import { MysqlConnector } from './mysql.ts'
import { PostgreSqlConnector } from './postgresql.ts'
import { ConnectorSupervisor } from './supervisor.ts'
import { DataSourcesBroker, type BrokerBootstrap, type BrokerRequest } from './broker.ts'
import type { DataSourcesProbeResult } from './api.ts'
import type { ReadRequest, SourceConfig } from './types.ts'

export const name = 'data-sources'
export const inject = ['tools', 'credentials']

export interface Config {
  sources: SourceConfig[]
  pythonCommand?: string
}

const Policy = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  maxRows: z.number().step(1).min(1).required(),
  allowedPath: z.string(),
  allowedPrefix: z.string(),
})

export const Config: z<Config> = z.object({
  pythonCommand: z.string().default('uv'),
  sources: z.array(z.object({
    id: z.string().required(),
    revision: z.string().required(),
    kind: z.union(['local-directory', 's3', 'sftp', 'smb', 'nfs', 'ftp', 'webdav', 'mysql', 'postgresql'] as const).required(),
    label: z.string().required(),
    enabled: z.boolean().default(true),
    credentialRef: z.string(),
    connection: z.object({
      endpoint: z.string(), bucket: z.string(), region: z.string(), host: z.string(), port: z.number().step(1).min(1).max(65535),
      database: z.string(), knownHostsPath: z.string(), timeoutMs: z.number().step(1).min(1), statementTimeoutMs: z.number().step(1).min(1),
      tls: z.object({ enabled: z.boolean(), caPath: z.string(), serverName: z.string() }),
    }).default({}),
    policy: Policy.required(),
  })).default([]),
})

const requestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'operation', 'input'],
  properties: {
    sourceId: { type: 'string' },
    operation: { type: 'string', enum: ['catalog', 'object.read', 'directory.list', 'sql.query'] },
    input: { type: 'object', additionalProperties: true },
    maxBytes: { type: 'integer', minimum: 1 },
    maxRows: { type: 'integer', minimum: 1 },
  },
} as const

function pythonEnvironment(bootstrap: BrokerBootstrap): Record<string, string> {
  const address = bootstrap.endpoint.transport === 'unix' ? bootstrap.endpoint.path : `tcp://${bootstrap.endpoint.host}:${bootstrap.endpoint.port}`
  return { DSH_DATA_SOURCES_BROKER: address, DSH_DATA_SOURCES_BROKER_CAPABILITY: bootstrap.capability }
}

async function admitBrokerOperation(supervisor: ConnectorSupervisor, request: BrokerRequest): Promise<unknown> {
  if (request.operation === 'database.acquire') {
    const intent = request.arguments.intent
    if (intent !== 'list' && intent !== 'describe' && intent !== 'query') throw new Error('data-sources: database intent is invalid')
    const sourceIds = request.arguments.source_ids
    if (!Array.isArray(sourceIds) || !sourceIds.every(id => typeof id === 'string')) {
      throw new Error('data-sources: database scope is required')
    }
    return supervisor.acquireDatabaseScope(
      sourceIds, positiveInteger(request.arguments.max_rows), positiveInteger(request.arguments.max_bytes),
    )
  }
  const sourceId = request.arguments.source_id
  if (request.operation === 'source_list') return supervisor.list()
  if (typeof sourceId !== 'string') throw new Error('data-sources: broker source_id is required')
  if (request.operation === 'source_info') return supervisor.inspect(sourceId)
  if (request.operation === 'source_probe') return await supervisor.probe(sourceId)
  if (request.operation === 'file.list') return await supervisor.listFiles(sourceId)
  if (request.operation === 'file.search') {
    const query = request.arguments.query
    if (typeof query !== 'string') throw new Error('data-sources: file search query is required')
    return await supervisor.listFiles(sourceId, query)
  }
  if (request.operation === 'file.read') {
    const objectId = request.arguments.object_id
    if (typeof objectId !== 'string') throw new Error('data-sources: file object id is required')
    return await supervisor.readFile(sourceId, objectId, positiveInteger(request.arguments.max_bytes))
  }
  // The remaining vocabulary is deliberately deny-by-default until its object-ID,
  // query-scope and DuckDB attachment admission is implemented in the Host.
  throw new Error('data-sources: broker operation is not admitted')
}
function positiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('data-sources: budget is invalid')
  return value
}


function mcpText(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

declare module '@deepseek-ai/cordis' {
  interface Context { dataSources: DataSourcesRemote }
}

/** Browser-safe remote surface: probes disclose no credentials, paths, or provider errors. */
export class DataSourcesRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly supervisor: ConnectorSupervisor) {
    super(ctx, 'dataSources')
  }

  @Remote
  async probe(request: { sourceId: string }, signal: AbortSignal): Promise<DataSourcesProbeResult> {
    signal.throwIfAborted()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.sourceId)) return { ok: false, message: 'Invalid source identifier.' }
    try {
      const result = await this.supervisor.probe(request.sourceId)
      signal.throwIfAborted()
      return { ok: true, source: result.source, connector: result.connector, observedAt: result.observedAt }
    } catch {
      return { ok: false, message: 'Connection test failed.' }
    }
  }
}

/** Register native read tools through the MCP result adapter so every result has one canonical projection. */
function applyDataSourceTools(ctx: Context, supervisor: ConnectorSupervisor): void {
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'data_sources_list', rawName: 'data_sources_list', description: 'List configured read-only data sources without credentials.',
    inputSchema: { type: 'object', additionalProperties: false },
    call: async () => mcpText(supervisor.list()),
  })))
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'data_sources_inspect', rawName: 'data_sources_inspect', description: 'Inspect a configured source policy without credentials.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sourceId'], properties: { sourceId: { type: 'string' } } },
    call: async args => mcpText(supervisor.inspect(String(args.sourceId))),
  })))
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'data_sources_probe', rawName: 'data_sources_probe', description: 'Test an enabled source without returning credentials or source contents.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sourceId'], properties: { sourceId: { type: 'string' } } },
    call: async args => mcpText(await supervisor.probe(String(args.sourceId))),
  })))
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'data_sources_read', rawName: 'data_sources_read', description: 'Perform a policy-limited read from a configured data source.',
    inputSchema: requestSchema,
    call: async args => mcpText(await supervisor.execute({ apiVersion: 'v1', ...args } as ReadRequest)),
  })))
}

/** Install native compatibility tools and a lifecycle-owned, capability-gated Python MCP child. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const supervisor = new ConnectorSupervisor(config.sources, [
    new LocalDirectoryConnector(), new S3Connector(), new SftpConnector(), new MountedDirectoryConnector('smb'), new MountedDirectoryConnector('nfs'), new FtpConnector(), new WebDavConnector(), new MysqlConnector(), new PostgreSqlConnector(),
  ], ctx.credentials)
  new DataSourcesRemote(ctx, supervisor)
  applyDataSourceTools(ctx, supervisor)
  const broker = new DataSourcesBroker((request, signal) => {
    signal.throwIfAborted()
    return admitBrokerOperation(supervisor, request)
  })
  const bootstrap = await broker.start()
  const cwd = fileURLToPath(new URL('../python', import.meta.url))
  let child!: Fiber
  ctx.effect(function* () {
    child = ctx.plugin(McpClient, McpClient.Config({
      transport: 'stdio', serverName: 'data-sources-python', command: config.pythonCommand ?? 'uv',
      args: ['run', '--frozen', 'dsh-data-sources-mcp'], cwd, env: pythonEnvironment(bootstrap),
      failOnStartupError: true, reconnect: { enabled: false },
    }))
    yield async () => { await child.dispose(); await broker.dispose() }
  }, 'data-sources.python-mcp')
  await child.await()
}

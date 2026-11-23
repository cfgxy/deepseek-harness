import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import { LocalDirectoryConnector } from './local-directory.ts'
import { S3Connector } from './s3.ts'
import { SftpConnector } from './sftp.ts'
import { MysqlConnector } from './mysql.ts'
import { PostgreSqlConnector } from './postgresql.ts'
import { ConnectorSupervisor } from './supervisor.ts'
import type { ReadRequest, SourceConfig } from './types.ts'

export const name = 'data-sources'
export const inject = ['tools', 'credentials']

export interface Config {
  sources: SourceConfig[]
}

const Policy = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  maxRows: z.number().step(1).min(1).required(),
  allowedPath: z.string(),
  allowedPrefix: z.string(),
})

export const Config: z<Config> = z.object({
  sources: z.array(z.object({
    id: z.string().required(),
    revision: z.string().required(),
    kind: z.union(['local-directory', 's3', 'sftp', 'mysql', 'postgresql'] as const).required(),
    label: z.string().required(),
    enabled: z.boolean().default(true),
    credentialRef: z.string(),
    connection: z.object({
      endpoint: z.string(), bucket: z.string(), region: z.string(), host: z.string(), port: z.number().step(1).min(1).max(65535),
      database: z.string(), knownHostsPath: z.string(), timeoutMs: z.number().step(1).min(1), statementTimeoutMs: z.number().step(1).min(1),
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

function mcpText(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
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

/** Install configuration-owned tools and the five independently lifecycle-owned read connectors. */
export function apply(ctx: Context, config: Config): void {
  const supervisor = new ConnectorSupervisor(config.sources, [
    new LocalDirectoryConnector(), new S3Connector(), new SftpConnector(), new MysqlConnector(), new PostgreSqlConnector(),
  ], ctx.credentials)
  applyDataSourceTools(ctx, supervisor)
}

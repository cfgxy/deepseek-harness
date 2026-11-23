import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import { ConnectorSupervisor, type ReadConnector } from './supervisor.ts'
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
export function applyDataSourceTools(ctx: Context, supervisor: ConnectorSupervisor): void {
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

/** Install configuration-owned tools. Concrete connectors are intentionally supplied by a deployment integration. */
export function apply(ctx: Context, config: Config): void {
  const supervisor = new ConnectorSupervisor(config.sources, [] as ReadConnector[], ctx.credentials)
  applyDataSourceTools(ctx, supervisor)
}

/* oxlint-disable @stylistic/max-len -- concise config validation keeps source kind invariants adjacent. */
import { isAbsolute } from 'node:path'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'

export const SOURCE_KINDS = ['local-directory', 's3', 'sftp', 'mysql', 'postgresql'] as const
export type SourceKind = typeof SOURCE_KINDS[number]
export type ReadOperation = 'catalog' | 'object.read' | 'directory.list' | 'sql.query'

export interface SourcePolicy {
  maxBytes: number
  maxRows: number
  allowedPath?: string
  allowedPrefix?: string
}
/** Non-secret connection coordinates. Authentication material always comes from credentialRef. */
export interface SourceConnection {
  endpoint?: string
  bucket?: string
  region?: string
  host?: string
  port?: number
  database?: string
  knownHostsPath?: string
  /** Connection deadline in milliseconds; defaults to 10 seconds when omitted. */
  timeoutMs?: number
  /** Per-statement database deadline in milliseconds; defaults to connection deadline. */
  statementTimeoutMs?: number
  /** Explicit opt-in; peer verification always remains enabled. */
  tls?: { enabled?: boolean; caPath?: string; serverName?: string }
}
export interface SourceConfig {
  id: string
  revision: string
  kind: SourceKind
  label: string
  enabled: boolean
  credentialRef?: string
  policy: SourcePolicy
  connection?: SourceConnection
}
export interface ReadRequest {
  apiVersion: 'v1'
  sourceId: string
  operation: ReadOperation
  input: Record<string, unknown>
  maxBytes?: number
  maxRows?: number
}
export interface ReadResult {
  source: { id: string; revision: string }
  data: unknown
  truncated: boolean
  evidence: { connector: string; observedAt: string; requestId: string }
}

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/
const endpoint = (source: SourceConfig) => source.connection?.endpoint
const host = (source: SourceConfig) => source.connection?.host

export function assertSourceConfig(source: SourceConfig): void {
  if (!SOURCE_ID.test(source.id)) throw new Error(`data-sources: invalid source id ${JSON.stringify(source.id)}`)
  if (source.revision.trim() === '') throw new Error(`data-sources: source ${source.id} needs a revision`)
  if (source.label.trim() === '') throw new Error(`data-sources: source ${source.id} needs a label`)
  if (!SOURCE_KINDS.includes(source.kind)) throw new Error(`data-sources: source ${source.id} has an unsupported kind`)
  if (source.credentialRef !== undefined && !isCredentialRefName(source.credentialRef)) throw new Error(`data-sources: source ${source.id} has an invalid credential reference`)
  if (!Number.isInteger(source.policy.maxBytes) || source.policy.maxBytes < 1) throw new Error(`data-sources: source ${source.id} maxBytes must be a positive integer`)
  if (!Number.isInteger(source.policy.maxRows) || source.policy.maxRows < 1) throw new Error(`data-sources: source ${source.id} maxRows must be a positive integer`)
  if (source.kind === 'local-directory' && (source.policy.allowedPath === undefined || !source.policy.allowedPath.startsWith('/') || source.policy.allowedPrefix !== undefined)) throw new Error(`data-sources: source ${source.id} requires an absolute allowedPath only`)
  if (source.kind === 'sftp' && (source.policy.allowedPath === undefined || !source.policy.allowedPath.startsWith('/') || source.policy.allowedPrefix !== undefined || !host(source) || !source.connection?.knownHostsPath)) throw new Error(`data-sources: source ${source.id} requires host, knownHostsPath, and absolute allowedPath`)
  if (source.kind === 's3' && (source.policy.allowedPrefix === undefined || source.policy.allowedPrefix.trim() === '' || source.policy.allowedPath !== undefined || !endpoint(source) || !source.connection?.bucket)) throw new Error(`data-sources: source ${source.id} requires endpoint, bucket, and allowedPrefix only`)
  if ((source.kind === 'mysql' || source.kind === 'postgresql') && (source.policy.allowedPath !== undefined || source.policy.allowedPrefix !== undefined || !host(source) || !source.connection?.database)) throw new Error(`data-sources: source ${source.id} requires host and database without a path policy`)
  if (source.connection?.port !== undefined && (!Number.isInteger(source.connection.port) || source.connection.port < 1 || source.connection.port > 65535)) {
    throw new Error(`data-sources: source ${source.id} has an invalid port`)
  }
  for (const [field, value] of [['timeoutMs', source.connection?.timeoutMs], ['statementTimeoutMs', source.connection?.statementTimeoutMs]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 120_000)) {
      throw new Error(`data-sources: source ${source.id} has an invalid ${field}`)
    }
  }
  const tls = source.connection?.tls
  if (tls !== undefined && (tls.caPath !== undefined || tls.serverName !== undefined) && tls.enabled !== true) {
    throw new Error(`data-sources: source ${source.id} TLS options require enabled=true`)
  }
  if (tls?.enabled === true) {
    if (source.kind !== 'mysql' && source.kind !== 'postgresql') throw new Error(`data-sources: source ${source.id} TLS is supported only for database connectors`)
    const { caPath, serverName } = tls
    if (caPath !== undefined && (!isAbsolute(caPath) || caPath.trim() === '')) throw new Error(`data-sources: source ${source.id} TLS caPath must be absolute`)
    if (serverName !== undefined && serverName.trim() === '') throw new Error(`data-sources: source ${source.id} TLS serverName must be non-empty`)
  }
}

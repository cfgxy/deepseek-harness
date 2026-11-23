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

export interface SourceConfig {
  id: string
  revision: string
  kind: SourceKind
  label: string
  enabled: boolean
  credentialRef?: string
  policy: SourcePolicy
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

export function assertSourceConfig(source: SourceConfig): void {
  if (!SOURCE_ID.test(source.id)) throw new Error(`data-sources: invalid source id ${JSON.stringify(source.id)}`)
  if (source.revision.trim() === '') throw new Error(`data-sources: source ${source.id} needs a revision`)
  if (source.label.trim() === '') throw new Error(`data-sources: source ${source.id} needs a label`)
  if (!SOURCE_KINDS.includes(source.kind)) throw new Error(`data-sources: source ${source.id} has an unsupported kind`)
  if (source.credentialRef !== undefined && !isCredentialRefName(source.credentialRef)) {
    throw new Error(`data-sources: source ${source.id} has an invalid credential reference`)
  }
  if (!Number.isInteger(source.policy.maxBytes) || source.policy.maxBytes < 1) {
    throw new Error(`data-sources: source ${source.id} maxBytes must be a positive integer`)
  }
  if (!Number.isInteger(source.policy.maxRows) || source.policy.maxRows < 1) {
    throw new Error(`data-sources: source ${source.id} maxRows must be a positive integer`)
  }
  if ((source.kind === 'local-directory' || source.kind === 'sftp')
    && (source.policy.allowedPath === undefined || !source.policy.allowedPath.startsWith('/') || source.policy.allowedPrefix !== undefined)) {
    throw new Error(`data-sources: source ${source.id} requires an absolute allowedPath only`)
  }
  if (source.kind === 's3'
    && (source.policy.allowedPrefix === undefined || source.policy.allowedPrefix.trim() === '' || source.policy.allowedPath !== undefined)) {
    throw new Error(`data-sources: source ${source.id} requires an allowedPrefix only`)
  }
  if ((source.kind === 'mysql' || source.kind === 'postgresql')
    && (source.policy.allowedPath !== undefined || source.policy.allowedPrefix !== undefined)) {
    throw new Error(`data-sources: source ${source.id} does not accept a path or prefix policy`)
  }
}

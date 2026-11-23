import { posix } from 'node:path'
import type { ReadOperation, ReadRequest, SourceConfig } from './types.ts'

const SQL_READ = /^(?:select|with|explain|show)\b/i
const SQL_WRITE = /\b(?:insert|update|delete|merge|alter|drop|create|grant|revoke|copy|call)\b/i

function stringInput(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`data-sources: ${field} must be a non-empty string`)
  return value
}

function operationAllowed(kind: SourceConfig['kind'], operation: ReadOperation): boolean {
  if (kind === 'local-directory' || kind === 'sftp') return operation === 'directory.list' || operation === 'object.read'
  if (kind === 'mysql' || kind === 'postgresql') return operation === 'catalog' || operation === 'sql.query'
  return operation === 'catalog' || operation === 'object.read'
}

function allowedPath(source: SourceConfig, candidate: string): boolean {
  const root = source.policy.allowedPath
  if (root === undefined) return false
  const normalizedRoot = posix.normalize(root)
  const normalizedCandidate = posix.normalize(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function allowedPrefix(source: SourceConfig, candidate: string): boolean {
  const prefix = source.policy.allowedPrefix
  if (prefix === undefined) return false
  const normalized = posix.normalize(candidate.replace(/^\/+/, ''))
  const normalizedPrefix = posix.normalize(prefix.replace(/^\/+|\/+$/g, ''))
  return normalized !== '..' && !normalized.startsWith('../')
    && (normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`))
}

/** Enforce source-local read policy and return an operation with concrete output budgets. */
export function guardRead(source: SourceConfig, request: ReadRequest): ReadRequest {
  if (!source.enabled) throw new Error(`data-sources: source ${source.id} is disabled`)
  if (!operationAllowed(source.kind, request.operation)) {
    throw new Error(`data-sources: ${request.operation} is not permitted for ${source.kind}`)
  }
  if (request.maxBytes !== undefined && request.maxBytes > source.policy.maxBytes) {
    throw new Error(`data-sources: requested byte limit exceeds source ${source.id} policy`)
  }
  if (request.maxRows !== undefined && request.maxRows > source.policy.maxRows) {
    throw new Error(`data-sources: requested row limit exceeds source ${source.id} policy`)
  }
  if (request.operation === 'sql.query') {
    const sql = stringInput(request.input, 'sql').trim()
    if (!SQL_READ.test(sql) || SQL_WRITE.test(sql) || sql.includes(';')) {
      throw new Error('data-sources: only one SELECT, WITH, EXPLAIN, or SHOW statement is permitted')
    }
  }
  if (request.operation === 'object.read' || request.operation === 'directory.list') {
    const path = stringInput(request.input, 'path')
    const allowed = source.kind === 's3' ? allowedPrefix(source, path) : allowedPath(source, path)
    if (!allowed) throw new Error(`data-sources: path is outside source ${source.id} allow-list`)
  }
  return {
    ...request,
    maxBytes: request.maxBytes ?? source.policy.maxBytes,
    maxRows: request.maxRows ?? source.policy.maxRows,
  }
}

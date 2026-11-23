import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult, SourceConfig } from './types.ts'

function rootOf(source: SourceConfig): string {
  const root = source.policy.allowedPath
  if (root === undefined) throw new Error(`data-sources: source ${source.id} has no local root`)
  return root
}

async function resolveWithin(request: ConnectorRequest, candidate?: string): Promise<string> {
  const root = await realpath(rootOf(request.source))
  const target = await realpath(resolve(candidate ?? root))
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`data-sources: resolved path escapes source ${request.source.id} root`)
  }
  return target
}

function entryKind(entry: Dirent): 'directory' | 'file' | 'other' {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  return 'other'
}

/** Read local files only after resolving both root and target to defeat symlink escapes. */
export class LocalDirectoryConnector implements ReadConnector {
  readonly kind = 'local-directory' as const

  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> {
    const root = await realpath(rootOf(request.source))
    if (!(await stat(root)).isDirectory()) throw new Error(`data-sources: source ${request.source.id} root is not a directory`)
  }

  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const path = typeof request.request.input.path === 'string' ? request.request.input.path : undefined
    const target = await resolveWithin(request, path)
    const maxBytes = request.request.maxBytes
    const maxRows = request.request.maxRows
    if (maxBytes === undefined || maxRows === undefined) throw new Error('data-sources: concrete budgets are required')

    if (request.request.operation === 'directory.list') {
      if (!(await stat(target)).isDirectory()) throw new Error(`data-sources: ${target} is not a directory`)
      const entries = await readdir(target, { withFileTypes: true })
      const data: { name: string; kind: 'directory' | 'file' | 'other' }[] = []
      let bytes = 0
      let truncated = false
      for (const entry of entries) {
        if (data.length === maxRows) { truncated = true; break }
        const item = { name: entry.name, kind: entryKind(entry) }
        const itemBytes = Buffer.byteLength(JSON.stringify(item))
        if (bytes + itemBytes > maxBytes) { truncated = true; break }
        data.push(item)
        bytes += itemBytes
      }
      return { data, truncated }
    }

    if (request.request.operation !== 'object.read') {
      throw new Error(`data-sources: ${request.request.operation} is not implemented by local-directory`)
    }
    if (!(await stat(target)).isFile()) throw new Error(`data-sources: ${target} is not a regular file`)
    const content = await readFile(target)
    const bounded = content.subarray(0, maxBytes)
    return {
      data: { path: target, bytes: bounded.byteLength, content: bounded.toString('utf8') },
      truncated: bounded.byteLength !== content.byteLength,
    }
  }
}

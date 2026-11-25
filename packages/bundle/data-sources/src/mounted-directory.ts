import { opendir, open, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult, SourceKind } from './types.ts'

/** SMB/NFS use an administrator-provisioned read-only mount; this connector never mounts or writes. */
export class MountedDirectoryConnector implements ReadConnector {
  constructor(readonly kind: Extract<SourceKind, 'smb' | 'nfs'>) {}
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> {
    const root = request.source.policy.allowedPath
    if (root === undefined || !(await stat(await realpath(root))).isDirectory()) throw new Error('data-sources: mounted root is unavailable')
  }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const configuredRoot = request.source.policy.allowedPath
    if (configuredRoot === undefined) throw new Error('data-sources: mounted root is unavailable')
    const root = await realpath(configuredRoot)
    const candidate = typeof request.request.input.path === 'string' ? request.request.input.path : root
    const target = await realpath(resolve(candidate))
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('data-sources: path escapes mounted root')
    const { maxBytes, maxRows } = request.request
    if (maxBytes === undefined || maxRows === undefined) throw new Error('data-sources: concrete budgets are required')
    if (request.request.operation === 'directory.list') {
      if (!(await stat(target)).isDirectory()) throw new Error('data-sources: target is not a directory')
      const dir = await opendir(target, { bufferSize: 1 }); const data: { name: string; kind: string }[] = []
      let bytes = 0; let truncated = false
      try { for (;;) { const item = await dir.read(); if (item === null) break; const value = { name: item.name, kind: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' }; const size = Buffer.byteLength(JSON.stringify(value)); if (data.length === maxRows || bytes + size > maxBytes) { truncated = true; break }; data.push(value); bytes += size } } finally { await dir.close() }
      return { data, truncated }
    }
    if (request.request.operation !== 'object.read' || !(await stat(target)).isFile()) throw new Error('data-sources: mounted source permits only regular-file reads')
    const file = await open(target, 'r'); try { const body = Buffer.allocUnsafe(maxBytes + 1); const { bytesRead } = await file.read(body, 0, body.length, 0); const bounded = body.subarray(0, Math.min(bytesRead, maxBytes)); return { data: { path: target, bytes: bounded.length, content: bounded.toString('utf8') }, truncated: bytesRead > maxBytes } } finally { await file.close() }
  }
}

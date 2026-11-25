import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, posix, resolve } from 'node:path'
import { guardRead } from './policy.ts'
import { assertSourceConfig, type ReadRequest, type ReadResult, type SourceConfig, type SourceKind, type SourcePolicy } from './types.ts'

export interface ConnectorRequest {
  source: SourceConfig
  request: ReadRequest
  credential?: string
}

export interface ReadConnector {
  readonly kind: SourceKind
  probe(request: Omit<ConnectorRequest, 'request'>): Promise<void>
  execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>>
}

export interface CredentialResolver {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined>
}

/** Private broker-only material. Never return this from a public MCP handler. */
export interface PrivateAttachmentDescriptor {
  id: string
  revision: string
  queryAlias: string
  kind: Extract<SourceKind, 'mysql' | 'postgresql'>
  host: string
  port: number
  database: string
  credential: string
  maxRows: number
  maxBytes: number
}

/** Owns configured sources, read-only policy admission, and per-operation credential resolution. */
function queryAlias(sourceId: string): string {
  return `src_${createHash('sha256').update(sourceId).digest('hex').slice(0, 16)}`
}

interface FileObject { sourceId: string; revision: string; path: string; name: string; issuedAt: number }
const FILE_OBJECT_TTL_MS = 5 * 60_000
const FILE_OBJECT_CAPACITY = 4096

function isChildName(value: string): boolean { return value === basename(value) && value !== '.' && value !== '..' && !value.includes('\0') }

function fileCandidates(source: SourceConfig, data: unknown): { name: string; path: string }[] {
  if ((source.kind === 'local-directory' || source.kind === 'smb' || source.kind === 'nfs') && Array.isArray(data)) {
    const root = source.policy.allowedPath
    if (root === undefined) return []
    return data.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const value = item as { name?: unknown; kind?: unknown }
      if (typeof value.name !== 'string' || value.kind !== 'file' || !isChildName(value.name)) return []
      return [{ name: value.name, path: resolve(root, value.name) }]
    })
  }
  if ((source.kind === 'sftp' || source.kind === 'ftp' || source.kind === 'webdav') && typeof data === 'object' && data !== null && Array.isArray((data as { entries?: unknown }).entries)) {
    const root = source.policy.allowedPath
    if (root === undefined) return []
    return (data as { entries: unknown[] }).entries.flatMap((value) => {
      if (typeof value !== 'string' || !isChildName(value)) return []
      return [{ name: value, path: posix.join(root, value) }]
    })
  }
  if (source.kind === 's3' && typeof data === 'object' && data !== null && Array.isArray((data as { keys?: unknown }).keys)) {
    const prefix = source.policy.allowedPrefix
    if (prefix === undefined) return []
    return (data as { keys: unknown[] }).keys.flatMap((value) => {
      if (typeof value !== 'string' || !value.startsWith(prefix)) return []
      return [{ name: value.slice(prefix.length), path: value }]
    })
  }
  return []
}

export class ConnectorSupervisor {
  readonly #sources = new Map<string, SourceConfig>()
  readonly #connectors = new Map<SourceKind, ReadConnector>()
  readonly #fileObjects = new Map<string, FileObject>()

  constructor(sources: readonly SourceConfig[], connectors: readonly ReadConnector[], private readonly credentials: CredentialResolver) {
    for (const source of sources) {
      assertSourceConfig(source)
      if (this.#sources.has(source.id)) throw new Error(`data-sources: duplicate source ${source.id}`)
      this.#sources.set(source.id, source)
    }
    for (const connector of connectors) {
      if (this.#connectors.has(connector.kind)) throw new Error(`data-sources: duplicate connector ${connector.kind}`)
      this.#connectors.set(connector.kind, connector)
    }
  }

  list(): readonly (Pick<SourceConfig, 'id' | 'revision' | 'kind' | 'label' | 'enabled'> & { queryAlias?: string })[] {
    return [...this.#sources.values()].map(source => ({
      id: source.id, revision: source.revision, kind: source.kind, label: source.label, enabled: source.enabled,
      ...source.kind === 'mysql' || source.kind === 'postgresql' ? { queryAlias: queryAlias(source.id) } : {},
    }))
  }

  inspect(sourceId: string): Pick<SourceConfig, 'id' | 'revision' | 'kind' | 'label' | 'enabled'> & { queryAlias?: string; policy: Pick<SourcePolicy, 'maxBytes' | 'maxRows'> } {
    const source = this.#source(sourceId)
    return {
      id: source.id,
      revision: source.revision,
      kind: source.kind,
      label: source.label,
      enabled: source.enabled,
      ...source.kind === 'mysql' || source.kind === 'postgresql' ? { queryAlias: queryAlias(source.id) } : {},
      policy: { maxBytes: source.policy.maxBytes, maxRows: source.policy.maxRows },
    }
  }

  async listFiles(
    sourceId: string, query?: string,
  ): Promise<{ objects: { object_id: string; name: string }[]; truncated: boolean }> {
    const source = this.#source(sourceId)
    if (source.kind !== 'local-directory' && source.kind !== 's3' && source.kind !== 'sftp' && source.kind !== 'smb' && source.kind !== 'nfs' && source.kind !== 'ftp' && source.kind !== 'webdav') {
      throw new Error('data-sources: file source is not admitted')
    }
    if (query !== undefined && (typeof query !== 'string' || query.trim() === '' || query.length > 128)) {
      throw new Error('data-sources: file search is invalid')
    }
    const request: ReadRequest = source.kind === 's3'
      ? { apiVersion: 'v1', sourceId, operation: 'catalog', input: {} }
      : { apiVersion: 'v1', sourceId, operation: 'directory.list', input: { path: source.policy.allowedPath } }
    const catalog = await this.execute(request)
    const term = query?.toLocaleLowerCase()
    const objects: { object_id: string; name: string }[] = []
    let bytes = 2; let truncated = catalog.truncated
    for (const candidate of fileCandidates(source, catalog.data)) {
      if (term !== undefined && !candidate.name.toLocaleLowerCase().includes(term)) continue
      const objectId = this.#mintFileObject(source, candidate)
      const item = { object_id: objectId, name: candidate.name }
      const size = Buffer.byteLength(JSON.stringify(item)) + (objects.length ? 1 : 0)
      if (objects.length >= source.policy.maxRows || bytes + size > source.policy.maxBytes) {
        this.#fileObjects.delete(objectId); truncated = true; break
      }
      objects.push(item); bytes += size
    }
    return { objects, truncated }
  }

  async readFile(
    sourceId: string, objectId: string, maxBytes?: number,
  ): Promise<{ source: { id: string; revision: string }; data: { bytes: number; content: string }; truncated: boolean }> {
    const source = this.#source(sourceId)
    const object = this.#resolveFileObject(source, objectId)
    const result = await this.execute({
      apiVersion: 'v1', sourceId, operation: 'object.read', input: { path: object.path },
      ...(maxBytes === undefined ? {} : { maxBytes }),
    })
    const data = result.data as { bytes?: unknown; content?: unknown }
    if (typeof data?.bytes !== 'number' || typeof data.content !== 'string') throw new Error('data-sources: file read is unavailable')
    return { source: result.source, data: { bytes: data.bytes, content: data.content }, truncated: result.truncated }
  }

  #mintFileObject(source: SourceConfig, candidate: { name: string; path: string }): string {
    this.#purgeFileObjects()
    if (this.#fileObjects.size >= FILE_OBJECT_CAPACITY) {
      const oldest = [...this.#fileObjects.entries()].reduce(
        (left, right) => left[1].issuedAt < right[1].issuedAt ? left : right,
      )[0]
      this.#fileObjects.delete(oldest)
    }
    const token = randomBytes(24).toString('base64url')
    this.#fileObjects.set(token, {
      sourceId: source.id, revision: source.revision, path: candidate.path,
      name: candidate.name, issuedAt: Date.now(),
    })
    return token
  }

  #resolveFileObject(source: SourceConfig, token: string): FileObject {
    this.#purgeFileObjects()
    const object = this.#fileObjects.get(token)
    if (object === undefined || object.sourceId !== source.id || object.revision !== source.revision) {
      throw new Error('data-sources: file object is not admitted')
    }
    return object
  }

  #purgeFileObjects(): void {
    const cutoff = Date.now() - FILE_OBJECT_TTL_MS
    for (const [token, object] of this.#fileObjects) if (object.issuedAt < cutoff) this.#fileObjects.delete(token)
  }

  async acquireDatabaseScope(
    sourceIds: readonly string[], maxRows?: number, maxBytes?: number,
  ): Promise<readonly PrivateAttachmentDescriptor[]> {
    if (sourceIds.length === 0 || sourceIds.length > 8 || new Set(sourceIds).size !== sourceIds.length) {
      throw new Error('data-sources: invalid database scope')
    }
    return Promise.all(sourceIds.map(async (id) => {
      const source = this.#source(id)
      const connection = source.connection
      if (!source.enabled || (source.kind !== 'mysql' && source.kind !== 'postgresql') || connection?.host === undefined || connection.database === undefined) {
        throw new Error('data-sources: database source is not admitted')
      }
      // DuckDB extension TLS settings have not yet been proven equivalent to
      // the Host connector's CA/server-name contract: fail closed, never downgrade.
      if (connection.tls?.enabled === true) throw new Error('data-sources: database TLS attachment is unavailable')
      if (maxRows !== undefined && maxRows > source.policy.maxRows) throw new Error('data-sources: requested row limit exceeds source policy')
      if (maxBytes !== undefined && maxBytes > source.policy.maxBytes) throw new Error('data-sources: requested byte limit exceeds source policy')
      const resolved = await this.#credential(source)
      if (resolved === undefined) throw new Error('data-sources: database source is unavailable')
      return { id: source.id, revision: source.revision, queryAlias: queryAlias(source.id), kind: source.kind, host: connection.host, port: connection.port ?? (source.kind === 'mysql' ? 3306 : 5432), database: connection.database, credential: resolved, maxRows: maxRows ?? source.policy.maxRows, maxBytes: maxBytes ?? source.policy.maxBytes }
    }))
  }

  async probe(sourceId: string): Promise<{ source: { id: string; revision: string }; connector: SourceKind; observedAt: string }> {
    const source = this.#source(sourceId)
    if (!source.enabled) throw new Error(`data-sources: source ${source.id} is disabled`)
    const connector = this.#connectors.get(source.kind)
    if (connector === undefined) throw new Error(`data-sources: connector ${source.kind} is unavailable`)
    const resolved = await this.#credential(source)
    await connector.probe({ source, ...(resolved === undefined ? {} : { credential: resolved }) })
    return { source: { id: source.id, revision: source.revision }, connector: connector.kind, observedAt: new Date().toISOString() }
  }

  async execute(request: ReadRequest): Promise<ReadResult> {
    if (request.apiVersion !== 'v1') throw new Error('data-sources: unsupported api version')
    const source = this.#source(request.sourceId)
    const admitted = guardRead(source, request)
    const connector = this.#connectors.get(source.kind)
    if (connector === undefined) throw new Error(`data-sources: connector ${source.kind} is unavailable`)
    const credential = await this.#credential(source)
    const result = await connector.execute({ source, request: admitted, ...(credential === undefined ? {} : { credential }) })
    return {
      source: { id: source.id, revision: source.revision },
      data: result.data,
      truncated: result.truncated,
      evidence: {
        connector: connector.kind,
        observedAt: new Date().toISOString(),
        requestId: randomUUID(),
      },
    }
  }

  async #credential(source: SourceConfig): Promise<string | undefined> {
    if (source.credentialRef === undefined) return undefined
    const resolved = await this.credentials.resolve(credentialRef(source.credentialRef))
    if (resolved === undefined) throw new Error(`data-sources: credential for source ${source.id} is unavailable`)
    return resolved.value
  }

  #source(id: string): SourceConfig {
    const source = this.#sources.get(id)
    if (source === undefined) throw new Error(`data-sources: unknown source ${id}`)
    return source
  }
}

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
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
  kind: Extract<SourceKind, 'mysql' | 'postgresql'>
  host: string
  port: number
  database: string
  credential: string
  maxRows: number
  maxBytes: number
}

/** Owns configured sources, read-only policy admission, and per-operation credential resolution. */
export class ConnectorSupervisor {
  readonly #sources = new Map<string, SourceConfig>()
  readonly #connectors = new Map<SourceKind, ReadConnector>()

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

  list(): readonly Pick<SourceConfig, 'id' | 'revision' | 'kind' | 'label' | 'enabled'>[] {
    return [...this.#sources.values()].map(({ id, revision, kind, label, enabled }) => ({ id, revision, kind, label, enabled }))
  }

  inspect(sourceId: string): Pick<SourceConfig, 'id' | 'revision' | 'kind' | 'label' | 'enabled'> & { policy: Pick<SourcePolicy, 'maxBytes' | 'maxRows'> } {
    const source = this.#source(sourceId)
    return {
      id: source.id,
      revision: source.revision,
      kind: source.kind,
      label: source.label,
      enabled: source.enabled,
      policy: { maxBytes: source.policy.maxBytes, maxRows: source.policy.maxRows },
    }
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
      if (maxRows !== undefined && maxRows > source.policy.maxRows) throw new Error('data-sources: requested row limit exceeds source policy')
      if (maxBytes !== undefined && maxBytes > source.policy.maxBytes) throw new Error('data-sources: requested byte limit exceeds source policy')
      const resolved = await this.#credential(source)
      if (resolved === undefined) throw new Error('data-sources: database source is unavailable')
      return { id: source.id, kind: source.kind, host: connection.host, port: connection.port ?? (source.kind === 'mysql' ? 3306 : 5432), database: connection.database, credential: resolved, maxRows: maxRows ?? source.policy.maxRows, maxBytes: maxBytes ?? source.policy.maxBytes }
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

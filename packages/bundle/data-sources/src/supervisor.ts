import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { guardRead } from './policy.ts'
import { assertSourceConfig, type ReadRequest, type ReadResult, type SourceConfig, type SourceKind } from './types.ts'

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

  inspect(sourceId: string): Pick<SourceConfig, 'id' | 'revision' | 'kind' | 'label' | 'enabled' | 'policy'> {
    const source = this.#source(sourceId)
    return {
      id: source.id,
      revision: source.revision,
      kind: source.kind,
      label: source.label,
      enabled: source.enabled,
      policy: { ...source.policy },
    }
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
    guardRead(source, request)
    const connector = this.#connectors.get(source.kind)
    if (connector === undefined) throw new Error(`data-sources: connector ${source.kind} is unavailable`)
    const credential = await this.#credential(source)
    const result = await connector.execute({ source, request, ...(credential === undefined ? {} : { credential }) })
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

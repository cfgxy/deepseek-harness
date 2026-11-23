import type { Context } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/** Namespace served by the Host data-sources bundle. */
export const DATA_SOURCES_NS = 'data-sources'

export type SourceKind = 'local-directory' | 's3' | 'sftp' | 'mysql' | 'postgresql'

/** The only fields the browser is allowed to read or persist for one source. */
export interface DataSourceDraft {
  id: string
  revision: string
  kind: SourceKind
  label: string
  enabled: boolean
  /** Credential identifier only; a secret is resolved exclusively by the Host. */
  credentialRef: string
  connection: {
    endpoint: string
    bucket: string
    region: string
    host: string
    port: string
    database: string
    knownHostsPath: string
    timeoutMs: string
    statementTimeoutMs: string
  }
  policy: { maxBytes: string; maxRows: string; allowedPath: string; allowedPrefix: string }
}

interface DataSourcesSettings { sources?: unknown }

export interface DataSourcesCardState {
  available: boolean
  writable: boolean
  sources: readonly DataSourceDraft[]
  probes: Readonly<Record<string, { pending: boolean; message: string }>>
}

export interface DataSourcesCardFace {
  hooks: { dataSourcesSettings: SnapshotStore<DataSourcesCardState> }
  add: () => void
  save: (source: DataSourceDraft) => void
  test: (sourceId: string) => void
}

type ProbeResponse = { ok: boolean; value?: unknown; error?: { message?: string } }
type ProbeRemote = { dataSources?: { probe: (request: { sourceId: string }) => Promise<ProbeResponse> } }

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'mysql', 'postgresql']
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const integer = (value: unknown): string => typeof value === 'number' && Number.isInteger(value) ? String(value) : ''

/** Read an object only long enough to copy its explicit public fields. */
function sourceDraft(value: unknown): DataSourceDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (!kinds.includes(source.kind as SourceKind)) return undefined
  const connection = typeof source.connection === 'object' && source.connection !== null && !Array.isArray(source.connection)
    ? source.connection as Record<string, unknown> : {}
  const policy = typeof source.policy === 'object' && source.policy !== null && !Array.isArray(source.policy)
    ? source.policy as Record<string, unknown> : {}
  return {
    id: text(source.id), revision: text(source.revision), kind: source.kind as SourceKind,
    label: text(source.label), enabled: source.enabled !== false, credentialRef: text(source.credentialRef),
    connection: {
      endpoint: text(connection.endpoint), bucket: text(connection.bucket), region: text(connection.region),
      host: text(connection.host), port: integer(connection.port), database: text(connection.database),
      knownHostsPath: text(connection.knownHostsPath), timeoutMs: integer(connection.timeoutMs),
      statementTimeoutMs: integer(connection.statementTimeoutMs),
    },
    policy: {
      maxBytes: integer(policy.maxBytes), maxRows: integer(policy.maxRows),
      allowedPath: text(policy.allowedPath), allowedPrefix: text(policy.allowedPrefix),
    },
  }
}

function requiredInteger(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Create the complete allowlisted Host config value. */
function serialise(source: DataSourceDraft): Record<string, unknown> {
  const connection = {
    endpoint: source.connection.endpoint.trim(), bucket: source.connection.bucket.trim(), region: source.connection.region.trim(),
    host: source.connection.host.trim(), port: requiredInteger(source.connection.port, 0), database: source.connection.database.trim(),
    knownHostsPath: source.connection.knownHostsPath.trim(), timeoutMs: requiredInteger(source.connection.timeoutMs, 10_000),
    statementTimeoutMs: requiredInteger(source.connection.statementTimeoutMs, 10_000),
  }
  const policy = {
    maxBytes: requiredInteger(source.policy.maxBytes, 65_536), maxRows: requiredInteger(source.policy.maxRows, 100),
    allowedPath: source.policy.allowedPath.trim(), allowedPrefix: source.policy.allowedPrefix.trim(),
  }
  return {
    id: source.id.trim(), revision: source.revision.trim(), kind: source.kind, label: source.label.trim(), enabled: source.enabled,
    ...(source.credentialRef.trim() === '' ? {} : { credentialRef: source.credentialRef.trim() }),
    connection: Object.fromEntries(Object.entries(connection).filter(([, value]) => value !== '' && value !== 0)),
    policy: Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== '')),
  }
}

function defaultSource(index: number): DataSourceDraft {
  return {
    id: `source-${index}`, revision: '1', kind: 'local-directory', label: `Data source ${index}`, enabled: true, credentialRef: '',
    connection: { endpoint: '', bucket: '', region: '', host: '', port: '', database: '', knownHostsPath: '', timeoutMs: '10000', statementTimeoutMs: '10000' },
    policy: { maxBytes: '65536', maxRows: '100', allowedPath: '/', allowedPrefix: '' },
  }
}

/** Bridges safe source metadata into the Plugins settings page. */
export class DataSourcesSettingsController {
  private readonly store: SnapshotStore<DataSourcesCardState>
  private readonly unsubscribe: () => void
  private disposed = false
  private probes: Record<string, { pending: boolean; message: string }> = {}

  constructor(private readonly scope: SettingsFormScope<DataSourcesSettings>, private readonly ctx: Context) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  private sources(): readonly DataSourceDraft[] {
    const value = this.scope.getSnapshot().value?.sources
    return Array.isArray(value) ? value.flatMap((item) => {
      const source = sourceDraft(item)
      return source === undefined ? [] : [source]
    }) : []
  }

  private projection(): DataSourcesCardState {
    const snapshot = this.scope.getSnapshot()
    return { available: snapshot.status === 'ready', writable: snapshot.writable, sources: this.sources(), probes: this.probes }
  }

  private publish(): void { if (!this.disposed) this.store.set(this.projection()) }

  private save(source: DataSourceDraft): void {
    let replaced = false
    const sources = this.sources().map((current) => {
      if (current.id !== source.id) return serialise(current)
      replaced = true
      return serialise(source)
    })
    if (!replaced) sources.push(serialise(source))
    void this.scope.mutate([{ op: 'set', path: ['sources'], value: sources }]).then(() => this.publish())
  }

  private add(): void { this.save(defaultSource(this.sources().length + 1)) }

  /** Probe only by source id. The browser never handles the source credential. */
  private test(sourceId: string): void {
    const remote = this.ctx.remote as unknown as ProbeRemote
    const probe = remote.dataSources?.probe
    if (probe === undefined) {
      this.probes = { ...this.probes, [sourceId]: { pending: false, message: 'Connection testing is unavailable in this Host.' } }
      this.publish()
      return
    }
    this.probes = { ...this.probes, [sourceId]: { pending: true, message: 'Testing connection…' } }
    this.publish()
    void probe({ sourceId }).then((response) => {
      const message = response.ok ? 'Connection succeeded.' : response.error?.message ?? 'Connection failed.'
      this.probes = { ...this.probes, [sourceId]: { pending: false, message } }
      this.publish()
    }, () => {
      this.probes = { ...this.probes, [sourceId]: { pending: false, message: 'Connection test could not be completed.' } }
      this.publish()
    })
  }

  inject(): DataSourcesCardFace {
    return {
      hooks: { dataSourcesSettings: this.store },
      add: () => this.add(), save: source => this.save(source), test: sourceId => this.test(sourceId),
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }
}

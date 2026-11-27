import type { Context } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/** Namespace served by the Host data-sources bundle. */
export const DATA_SOURCES_NS = 'data-sources'

export type SourceKind = 'local-directory' | 's3' | 'sftp' | 'smb' | 'nfs' | 'ftp' | 'webdav' | 'mysql' | 'postgresql'
export type DraftKind = SourceKind | ''

/** Browser-safe projection of one source. It intentionally has no secret value field. */
export interface DataSourceDraft {
  id: string
  revision: string
  kind: DraftKind
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
    tlsEnabled: boolean
    tlsCaPath: string
    tlsServerName: string
  }
  policy: { maxBytes: string; maxRows: string; allowedPath: string; allowedPrefix: string }
}

interface DataSourcesSettings { sources?: unknown }
export type ProbeState = { phase: 'idle' | 'pending' | 'success' | 'error'; message?: string }

export type SaveResult = 'saved' | 'conflict' | 'failed'

export interface EnvStatusState {
  checked: boolean
  hasUv: boolean
  hasPython: boolean
  mcpRunning: boolean
  installing: boolean
  reloading: boolean
  message?: string | undefined
  error?: string | undefined
}

interface DataSourcesRemoteClient {
  probe: (request: { sourceId: string }) => Promise<{ ok: boolean; value: { ok: boolean } }>
  checkEnvironment?: () => Promise<{ ok: boolean; value: { hasUv: boolean; hasPython: boolean; mcpRunning: boolean } }>
  installEnvironment?: () => Promise<{ ok: boolean; value: { ok: boolean; message: string } }>
  reloadMcp?: () => Promise<{ ok: boolean; value: { ok: boolean; message: string } }>
  listCredentials?: () => Promise<{
    ok: boolean
    value: {
      ok: boolean
      credentials: Array<{ ref: string; configured: boolean; source?: string; writable: boolean }>
    }
  }>
  saveCredential?: (request: { ref: string; value: string }) => Promise<{
    ok: boolean
    value: { ok: boolean; message?: string }
  }>
  deleteCredential?: (request: { ref: string }) => Promise<{
    ok: boolean
    value: { ok: boolean; message?: string }
  }>
}

export interface DataSourcesCardState {
  available: boolean
  writable: boolean
  saving: boolean
  /** Identifies the live controller; drafts must not cross controller lifetimes. */
  controllerId: number
  /** The Host configuration revision on which the projected sources are based. */
  scopeRevision: number
  sources: readonly DataSourceDraft[]
  probes: Readonly<Record<string, ProbeState>>
  envStatus: EnvStatusState
  credentials: readonly { ref: string; configured: boolean; source?: string; writable: boolean }[]
}

export interface DataSourcesCardFace {
  hooks: { dataSourcesSettings: SnapshotStore<DataSourcesCardState> }
  create: () => DataSourceDraft
  save: (source: DataSourceDraft, expectedScopeRevision: number) => Promise<SaveResult>
  remove: (sourceId: string) => Promise<boolean>
  setEnabled: (sourceId: string, enabled: boolean) => Promise<boolean>
  test: (sourceId: string) => void
  installEnvironment: () => void
  reloadMcp: () => void
  saveCredential: (ref: string, value: string) => Promise<{ ok: boolean; message?: string }>
  deleteCredential: (ref: string) => Promise<{ ok: boolean; message?: string }>
  refreshCredentials: () => Promise<void>
}

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'smb', 'nfs', 'ftp', 'webdav', 'mysql', 'postgresql']
let nextControllerId = 1
const directoryKinds: readonly SourceKind[] = ['local-directory', 'smb', 'nfs', 'sftp', 'ftp', 'webdav']
const databaseKinds: readonly SourceKind[] = ['mysql', 'postgresql']
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const integer = (value: unknown): string => typeof value === 'number' && Number.isInteger(value) ? String(value) : ''
const optionalInteger = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value)

/** Read an object only long enough to copy its explicit non-secret fields. */
export function sourceDraft(value: unknown): DataSourceDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (!kinds.includes(source.kind as SourceKind)) return undefined
  const connection = typeof source.connection === 'object' && source.connection !== null && !Array.isArray(source.connection)
    ? source.connection as Record<string, unknown> : {}
  const policy = typeof source.policy === 'object' && source.policy !== null && !Array.isArray(source.policy)
    ? source.policy as Record<string, unknown> : {}
  const tls = typeof connection.tls === 'object' && connection.tls !== null && !Array.isArray(connection.tls)
    ? connection.tls as Record<string, unknown> : {}
  return {
    id: text(source.id), revision: text(source.revision), kind: source.kind as SourceKind,
    label: text(source.label), enabled: source.enabled !== false, credentialRef: text(source.credentialRef),
    connection: {
      endpoint: text(connection.endpoint), bucket: text(connection.bucket), region: text(connection.region),
      host: text(connection.host), port: integer(connection.port), database: text(connection.database),
      knownHostsPath: text(connection.knownHostsPath), timeoutMs: integer(connection.timeoutMs),
      statementTimeoutMs: integer(connection.statementTimeoutMs), tlsEnabled: tls.enabled === true,
      tlsCaPath: text(tls.caPath), tlsServerName: text(tls.serverName),
    },
    policy: {
      maxBytes: integer(policy.maxBytes), maxRows: integer(policy.maxRows),
      allowedPath: text(policy.allowedPath), allowedPrefix: text(policy.allowedPrefix),
    },
  }
}

/** Return the first user-facing validation problem without sending an invalid draft. */
export function validateDraft(source: DataSourceDraft): string | undefined {
  if (!kinds.includes(source.kind as SourceKind)) return 'Select a source type.'
  if (source.label.trim() === '') return 'Enter a source name.'
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(source.id)) return 'Source ID is invalid.'
  if (source.credentialRef.trim() !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.credentialRef.trim())) return 'Credential reference is invalid.'
  for (const [name, value] of [['maxBytes', source.policy.maxBytes], ['maxRows', source.policy.maxRows]] as const) {
    if (!Number.isInteger(Number(value)) || Number(value) < 1) return `${name} must be a positive integer.`
  }
  const port = optionalInteger(source.connection.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) return 'Port must be a whole number from 1 to 65535.'
  for (const value of [source.connection.timeoutMs, source.connection.statementTimeoutMs]) {
    const parsed = optionalInteger(value)
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 120_000)) return 'Timeout must be a whole number from 1 to 120000.'
  }
  const kind = source.kind as SourceKind
  if (directoryKinds.includes(kind) && !source.policy.allowedPath.trim().startsWith('/')) return 'Enter an absolute path starting with /.'
  if (kind === 's3' && (source.connection.endpoint.trim() === '' || source.connection.bucket.trim() === '' || source.policy.allowedPrefix.trim() === '')) return 'Endpoint, bucket, and object prefix are required.'
  if (kind === 'sftp' && (source.connection.host.trim() === '' || source.connection.knownHostsPath.trim() === '')) return 'Host and known hosts file are required.'
  if (kind === 'ftp' && source.connection.host.trim() === '') return 'Host is required.'
  if (kind === 'webdav') {
    try {
      const endpoint = new URL(source.connection.endpoint)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error()
    } catch { return 'Enter an HTTPS WebDAV endpoint without credentials, query, or fragment.' }
  }
  if (databaseKinds.includes(kind) && (source.connection.host.trim() === '' || source.connection.database.trim() === '')) return 'Host and database name are required.'
  if (source.connection.tlsEnabled && !databaseKinds.includes(kind)) return 'TLS is available only for database sources.'
  if (source.connection.tlsEnabled && source.connection.tlsCaPath.trim() !== '' && !source.connection.tlsCaPath.trim().startsWith('/')) return 'CA certificate path must be absolute.'
  return undefined
}

/** Convert a browser draft into the exact per-kind allowlist accepted by the Host. */
export function serialise(source: DataSourceDraft): Record<string, unknown> {
  const kind = source.kind as SourceKind
  const connection: Record<string, unknown> = {}
  const add = (key: keyof DataSourceDraft['connection']) => {
    const value = source.connection[key]
    if (typeof value === 'string' && value.trim() !== '') connection[key] = value.trim()
  }
  if (kind === 's3' || kind === 'webdav') add('endpoint')
  if (kind === 's3') { add('bucket'); add('region') }
  if (['sftp', 'ftp', 'mysql', 'postgresql'].includes(kind)) add('host')
  if (kind === 'sftp') add('knownHostsPath')
  if (databaseKinds.includes(kind)) add('database')
  const port = optionalInteger(source.connection.port)
  if (port !== undefined) connection.port = port
  const timeout = optionalInteger(source.connection.timeoutMs)
  if (timeout !== undefined) connection.timeoutMs = timeout
  if (databaseKinds.includes(kind)) {
    const statementTimeout = optionalInteger(source.connection.statementTimeoutMs)
    if (statementTimeout !== undefined) connection.statementTimeoutMs = statementTimeout
    if (source.connection.tlsEnabled) {
      connection.tls = {
        enabled: true,
        ...source.connection.tlsCaPath.trim() === '' ? {} : { caPath: source.connection.tlsCaPath.trim() },
        ...source.connection.tlsServerName.trim() === '' ? {} : { serverName: source.connection.tlsServerName.trim() },
      }
    }
  }
  const policy: Record<string, unknown> = { maxBytes: Number(source.policy.maxBytes), maxRows: Number(source.policy.maxRows) }
  if (directoryKinds.includes(kind)) policy.allowedPath = source.policy.allowedPath.trim()
  if (kind === 's3') policy.allowedPrefix = source.policy.allowedPrefix.trim()
  return {
    id: source.id.trim(), revision: source.revision.trim() || '1', kind, label: source.label.trim(), enabled: source.enabled,
    ...source.credentialRef.trim() === '' ? {} : { credentialRef: source.credentialRef.trim() },
    ...Object.keys(connection).length === 0 ? {} : { connection }, policy,
  }
}

function draftSignature(source: DataSourceDraft): string { return JSON.stringify(serialise(source)) }

/** Bridges safe source metadata into the Plugins settings page. */
export class DataSourcesSettingsController {
  private readonly store: SnapshotStore<DataSourcesCardState>
  private readonly unsubscribe: () => void
  private readonly controllerId = nextControllerId++
  private disposed = false
  private saving = false
  private nextId = 1
  private probes: Record<string, ProbeState> = {}
  private credentials: readonly { ref: string; configured: boolean; source?: string; writable: boolean }[] = []
  private envStatus: EnvStatusState = {
    checked: false,
    hasUv: false,
    hasPython: false,
    mcpRunning: false,
    installing: false,
    reloading: false,
  }

  constructor(private readonly scope: SettingsFormScope<DataSourcesSettings>, private readonly ctx: Context) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
    void this.checkEnvironment()
    void this.refreshCredentials()
  }

  private sources(): readonly DataSourceDraft[] {
    const value = this.scope.getSnapshot().value?.sources
    return Array.isArray(value) ? value.flatMap((item) => {
      const source = sourceDraft(item)
      return source === undefined ? [] : [source]
    }) : []
  }

  private scopeRevision(): number { return this.scope.getSnapshot().revision ?? 0 }

  private projection(): DataSourcesCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      saving: this.saving,
      controllerId: this.controllerId,
      scopeRevision: snapshot.revision ?? 0,
      sources: this.sources(),
      probes: this.probes,
      envStatus: this.envStatus,
      credentials: this.credentials,
    }
  }

  private publish(): void { if (!this.disposed) this.store.set(this.projection()) }

  private async write(sources: readonly DataSourceDraft[], expectedScopeRevision: number): Promise<SaveResult> {
    const snapshot = this.scope.getSnapshot()
    if (this.saving || !snapshot.writable) return 'failed'
    // Never replace an external update with a draft based on an older snapshot.
    if ((snapshot.revision ?? 0) !== expectedScopeRevision) return 'conflict'
    this.saving = true
    this.publish()
    try {
      return await this.scope.mutate([{ op: 'set', path: ['sources'], value: sources.map(serialise) }], expectedScopeRevision) ? 'saved' : 'conflict'
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private clearProbe(sourceId: string): void {
    const { [sourceId]: _removed, ...remaining } = this.probes
    this.probes = remaining
  }

  private save(source: DataSourceDraft, expectedScopeRevision: number): Promise<SaveResult> {
    if (this.scopeRevision() !== expectedScopeRevision) return Promise.resolve('conflict')
    const existing = this.sources()
    const sources = existing.some(current => current.id === source.id)
      ? existing.map(current => current.id === source.id ? source : current)
      : [...existing, source]
    this.clearProbe(source.id)
    return this.write(sources, expectedScopeRevision)
  }

  private remove(sourceId: string): Promise<boolean> {
    this.clearProbe(sourceId)
    return this.write(this.sources().filter(source => source.id !== sourceId), this.scopeRevision()).then(result => result === 'saved')
  }

  private setEnabled(sourceId: string, enabled: boolean): Promise<boolean> {
    this.clearProbe(sourceId)
    return this.write(this.sources().map(source => source.id === sourceId ? { ...source, enabled } : source), this.scopeRevision()).then(result => result === 'saved')
  }

  private create(): DataSourceDraft {
    const ids = new Set(this.sources().map(source => source.id))
    let id = `source-${this.nextId++}`
    while (ids.has(id)) id = `source-${this.nextId++}`
    return {
      id, revision: '1', kind: '', label: '', enabled: true, credentialRef: '',
      connection: { endpoint: '', bucket: '', region: '', host: '', port: '', database: '', knownHostsPath: '', timeoutMs: '10000', statementTimeoutMs: '', tlsEnabled: false, tlsCaPath: '', tlsServerName: '' },
      policy: { maxBytes: '65536', maxRows: '100', allowedPath: '', allowedPrefix: '' },
    }
  }

  /** Probe only a saved source id and ignore answers made stale by a subsequent write. */
  private test(sourceId: string): void {
    const source = this.sources().find(candidate => candidate.id === sourceId)
    if (source === undefined || !source.enabled || this.saving) return
    const signature = draftSignature(source)
    this.probes = { ...this.probes, [sourceId]: { phase: 'pending', message: 'Testing connection…' } }
    this.publish()
    void this.ctx.remote.dataSources.probe({ sourceId }).then((response) => {
      const current = this.sources().find(candidate => candidate.id === sourceId)
      if (current === undefined || !current.enabled || draftSignature(current) !== signature) return
      const message = response.ok && response.value.ok ? 'Connection succeeded.' : 'Connection test failed. Check the connection settings and the credential reference on the host.'
      this.probes = { ...this.probes, [sourceId]: { phase: response.ok && response.value.ok ? 'success' : 'error', message } }
      this.publish()
    }, () => {
      const current = this.sources().find(candidate => candidate.id === sourceId)
      if (current === undefined || !current.enabled || draftSignature(current) !== signature) return
      this.probes = { ...this.probes, [sourceId]: { phase: 'error', message: 'Connection test could not be completed.' } }
      this.publish()
    })
  }

  private get remote(): DataSourcesRemoteClient | undefined {
    return (this.ctx.remote as unknown as { dataSources?: DataSourcesRemoteClient }).dataSources
  }

  private async checkEnvironment(): Promise<void> {
    try {
      const res = await this.remote?.checkEnvironment?.()
      if (res && res.ok) {
        this.envStatus = {
          ...this.envStatus,
          checked: true,
          hasUv: res.value.hasUv,
          hasPython: res.value.hasPython,
          mcpRunning: res.value.mcpRunning,
        }
        this.publish()
      }
    } catch {
      // remote check not available
    }
  }

  private async installEnvironment(): Promise<void> {
    if (this.envStatus.installing) return
    this.envStatus = { ...this.envStatus, installing: true, message: undefined, error: undefined }
    this.publish()
    try {
      const res = await this.remote?.installEnvironment?.()
      if (res && res.ok && res.value.ok) {
        this.envStatus = {
          ...this.envStatus,
          installing: false,
          mcpRunning: true,
          hasUv: true,
          hasPython: true,
          message: res.value.message,
        }
      } else {
        this.envStatus = {
          ...this.envStatus,
          installing: false,
          error: res?.value?.message ?? '安装执行失败',
        }
      }
    } catch (err) {
      this.envStatus = {
        ...this.envStatus,
        installing: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    this.publish()
  }

  private async reloadMcp(): Promise<void> {
    if (this.envStatus.reloading) return
    this.envStatus = { ...this.envStatus, reloading: true, message: undefined, error: undefined }
    this.publish()
    try {
      const res = await this.remote?.reloadMcp?.()
      if (res && res.ok && res.value.ok) {
        this.envStatus = {
          ...this.envStatus,
          reloading: false,
          mcpRunning: true,
          message: res.value.message,
        }
      } else {
        this.envStatus = {
          ...this.envStatus,
          reloading: false,
          error: res?.value?.message ?? 'MCP 重载失败',
        }
      }
    } catch (err) {
      this.envStatus = {
        ...this.envStatus,
        reloading: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    this.publish()
  }

  private async refreshCredentials(): Promise<void> {
    try {
      const res = await this.remote?.listCredentials?.()
      if (res && res.ok && res.value?.ok) {
        this.credentials = res.value.credentials
        this.publish()
      }
    } catch {
      // remote credential list not available
    }
  }

  private async saveCredential(ref: string, value: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await this.remote?.saveCredential?.({ ref, value })
      if (res && res.ok && res.value?.ok) {
        await this.refreshCredentials()
        return { ok: true }
      }
      return { ok: false, message: res?.value?.message ?? '保存凭据失败' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  private async deleteCredential(ref: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await this.remote?.deleteCredential?.({ ref })
      if (res && res.ok && res.value?.ok) {
        await this.refreshCredentials()
        return { ok: true }
      }
      return { ok: false, message: res?.value?.message ?? '删除凭据失败' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  inject(): DataSourcesCardFace {
    return {
      hooks: { dataSourcesSettings: this.store },
      create: () => this.create(),
      save: (source, expectedScopeRevision) => this.save(source, expectedScopeRevision),
      remove: sourceId => this.remove(sourceId),
      setEnabled: (sourceId, enabled) => this.setEnabled(sourceId, enabled),
      test: (sourceId) => { this.test(sourceId) },
      installEnvironment: () => { void this.installEnvironment() },
      reloadMcp: () => { void this.reloadMcp() },
      saveCredential: (ref, value) => this.saveCredential(ref, value),
      deleteCredential: ref => this.deleteCredential(ref),
      refreshCredentials: () => this.refreshCredentials(),
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }
}

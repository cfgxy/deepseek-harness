/** Browser-safe response from a data-source connectivity probe. */
export interface DataSourcesProbeResult {
  ok: boolean
  source?: { id: string; revision: string }
  connector?: 'local-directory' | 's3' | 'sftp' | 'smb' | 'nfs' | 'ftp' | 'webdav' | 'mysql' | 'postgresql'
  observedAt?: string
  message?: string
}

/** Browser-safe report on Python and uv environment status. */
export interface DataSourcesEnvStatus {
  hasPython: boolean
  hasUv: boolean
  mcpRunning: boolean
  uvPath?: string | undefined
  message?: string | undefined
}

/** Result of one-click environment installation or reload. */
export interface DataSourcesInstallResult {
  ok: boolean
  message: string
}

/** Summary of a credential reference available on the host. */
export interface DataSourcesCredentialSummary {
  ref: string
  configured: boolean
  source?: string | undefined
  writable: boolean
}

/** Result of listing host credentials. */
export interface DataSourcesCredentialListResult {
  ok: boolean
  credentials: DataSourcesCredentialSummary[]
}

/** Result of saving or deleting a host credential. */
export interface DataSourcesCredentialMutationResult {
  ok: boolean
  message?: string
}

/** Browser-safe response from a data-source connectivity probe. */
export interface DataSourcesProbeResult {
  ok: boolean
  source?: { id: string; revision: string }
  connector?: 'local-directory' | 's3' | 'sftp' | 'mysql' | 'postgresql'
  observedAt?: string
  message?: string
}

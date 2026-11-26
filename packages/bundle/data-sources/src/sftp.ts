/* oxlint-disable typescript/no-non-null-assertion -- guardRead concretizes budgets before dispatch. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

function credentials(value: string | undefined): { username: string; privateKey: string } {
  if (!value) throw new Error('data-sources: SFTP credential is required')
  try {
    const raw = JSON.parse(value) as Record<string, unknown>
    if (typeof raw.username === 'string' && typeof raw.privateKey === 'string') return { username: raw.username, privateKey: raw.privateKey }
  } catch {}
  throw new Error('data-sources: SFTP credential must be JSON with username and privateKey')
}

/** Uses curl's SFTP stream with an isolated OpenSSH known-host home; ephemeral private-key files are removed per operation. */
export class SftpConnector implements ReadConnector {
  readonly kind = 'sftp' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#run(request, '/', 1, 1) }

  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const path = String(request.request.input.path)
    if (request.request.operation === 'directory.list') {
      const { stdout, truncated: upstreamTruncated } = await this.#run(
        request, path, request.request.maxBytes! + 1, request.request.maxRows! + 1,
      )
      const listed = stdout.toString('utf8').split(/\r?\n/).filter(Boolean)
      const entries: string[] = []; let bytes = 2; let truncated = upstreamTruncated
      for (const entry of listed) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0)
        if (entries.length === request.request.maxRows! || bytes + size > request.request.maxBytes!) { truncated = true; break }
        entries.push(entry); bytes += size
      }
      return { data: { path, entries }, truncated: truncated || listed.length > entries.length }
    }
    const { stdout, truncated } = await this.#run(request, path, request.request.maxBytes! + 1)
    const content = stdout.subarray(0, request.request.maxBytes)
    return { data: { path, bytes: content.byteLength, content: content.toString('utf8') }, truncated }
  }

  /** Stops curl after one output byte or one listed row beyond the requested budgets. */
  async #run(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, path: string, byteLimit: number, lineLimit?: number): Promise<{ stdout: Buffer; truncated: boolean }> {
    const { username, privateKey } = credentials(request.credential)
    const { host, port = 22, knownHostsPath } = request.source.connection!
    const keyDir = await mkdtemp(join(tmpdir(), 'dsh-sftp-key-')); const keyFile = join(keyDir, 'id')
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 })
      await mkdir(join(keyDir, '.ssh'))
      await writeFile(join(keyDir, '.ssh', 'known_hosts'), await readFile(knownHostsPath!))
      const encodedPath = path.split('/').map(encodeURIComponent).join('/')
      const url = `sftp://${host}:${port}${encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`}`
      const args = ['--silent', '--show-error', '--fail', '--proto', '=sftp', '--user', `${username}:`, '--key', keyFile, '--disable']
      if (lineLimit !== undefined) args.push('--list-only')
      args.push(url)
      return await new Promise<{ stdout: Buffer; truncated: boolean }>((resolve, reject) => {
        const child = spawn('curl', args, { env: { PATH: process.env.PATH ?? '', HOME: keyDir } })
        const timeout = request.source.connection?.timeoutMs ?? 10_000
        const chunks: Buffer[] = []; let size = 0; let lines = 0; let truncated = false; let timedOut = false; let stderr = ''
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
        child.stdout.on('data', (value: Buffer) => {
          const chunk = Buffer.from(value)
          const remaining = Math.max(0, byteLimit - size)
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          size += chunk.byteLength
          lines += chunk.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0)
          if (size >= byteLimit || (lineLimit !== undefined && lines >= lineLimit)) { truncated = true; child.kill('SIGKILL') }
        })
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { stderr += data })
        child.once('error', reject); child.once('close', (code) => {
          clearTimeout(timer)
          if (truncated) resolve({ stdout: Buffer.concat(chunks), truncated: true })
          else if (code === 0) resolve({ stdout: Buffer.concat(chunks), truncated: false })
          else if (timedOut) reject(new Error(`data-sources: SFTP operation timed out after ${timeout}ms`))
          else reject(new Error(stderr || `exit ${code}`))
        })
      })
    } catch (error) { throw new Error(`data-sources: SFTP operation failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await rm(keyDir, { recursive: true, force: true }) }
  }
}

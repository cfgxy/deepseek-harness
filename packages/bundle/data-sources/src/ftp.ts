/* oxlint-disable typescript/no-non-null-assertion -- guardRead concretizes budgets before dispatch. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

function credentials(value: string | undefined): { username: string; password: string } {
  if (value === undefined) throw new Error('data-sources: FTP credential is required')
  try {
    const raw = JSON.parse(value) as Record<string, unknown>
    if (typeof raw.username === 'string' && raw.username !== '' && !/[\r\n]/.test(raw.username) && typeof raw.password === 'string' && !/[\r\n]/.test(raw.password)) {
      return { username: raw.username, password: raw.password }
    }
  } catch {}
  throw new Error('data-sources: FTP credential must be JSON with username and password')
}

function encodePath(path: string): string { return path.split('/').map(encodeURIComponent).join('/') }

function netrcToken(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }

/** Uses curl's FTP reader with a per-operation private netrc; it never uploads, deletes, or renames. */
export class FtpConnector implements ReadConnector {
  readonly kind = 'ftp' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#run(request, request.source.policy.allowedPath!, 1, 1) }

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

  /** Stops curl after one output byte or listed row beyond the concrete policy budget. */
  async #run(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, path: string, byteLimit: number, lineLimit?: number): Promise<{ stdout: Buffer; truncated: boolean }> {
    const { username, password } = credentials(request.credential)
    const { host, port = 21 } = request.source.connection!
    const root = await mkdtemp(join(tmpdir(), 'dsh-ftp-'))
    const netrc = join(root, 'netrc')
    try {
      await writeFile(netrc, `machine ${netrcToken(host!)}\nlogin ${netrcToken(username)}\npassword ${netrcToken(password)}\n`, { mode: 0o600 })
      const url = `ftp://${host}:${port}${encodePath(path).startsWith('/') ? encodePath(path) : `/${encodePath(path)}`}`
      const args = ['--silent', '--show-error', '--fail', '--proto', '=ftp', '--netrc-file', netrc, '--disable']
      if (lineLimit !== undefined) args.push('--list-only')
      args.push(url)
      return await new Promise<{ stdout: Buffer; truncated: boolean }>((resolve, reject) => {
        const child = spawn('curl', args, { env: { PATH: process.env.PATH ?? '', HOME: root } })
        const timeout = request.source.connection?.timeoutMs ?? 10_000
        const chunks: Buffer[] = []; let size = 0; let lines = 0; let truncated = false; let timedOut = false; let stderr = ''
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
        child.stdout.on('data', (value: Buffer) => {
          const chunk = Buffer.from(value)
          const remaining = Math.max(0, byteLimit - size)
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          size += chunk.byteLength
          lines += chunk.reduce<number>((count, byte) => count + (byte === 10 ? 1 : 0), 0)
          if (size >= byteLimit || (lineLimit !== undefined && lines >= lineLimit)) { truncated = true; child.kill('SIGKILL') }
        })
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (data: string) => { stderr += data })
        child.once('error', reject); child.once('close', (code) => {
          clearTimeout(timer)
          if (truncated) resolve({ stdout: Buffer.concat(chunks), truncated: true })
          else if (code === 0) resolve({ stdout: Buffer.concat(chunks), truncated: false })
          else if (timedOut) reject(new Error(`data-sources: FTP operation timed out after ${timeout}ms`))
          else reject(new Error(stderr || `exit ${code}`))
        })
      })
    } catch (error) { throw new Error(`data-sources: FTP operation failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await rm(root, { recursive: true, force: true }) }
  }
}

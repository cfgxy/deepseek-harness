/* oxlint-disable typescript/no-non-null-assertion -- guardRead concretizes budgets before dispatch. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
/** Uses OpenSSH in strict known-host mode; an ephemeral key file is removed after every operation. */
export class SftpConnector implements ReadConnector {
  readonly kind = 'sftp' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> { await this.#run(request, 'ls .') }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const path = String(request.request.input.path)
    if (request.request.operation === 'directory.list') {
      const output = await this.#run(request, `ls -1 ${this.#quote(path)}`)
      const listed = output.split(/\r?\n/).filter(Boolean)
      const entries: string[] = []; let bytes = 2; let truncated = false
      for (const entry of listed) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0)
        if (entries.length === request.request.maxRows! || bytes + size > request.request.maxBytes!) { truncated = true; break }
        entries.push(entry); bytes += size
      }
      return { data: { path, entries }, truncated: truncated || listed.length > entries.length }
    }
    const dir = await mkdtemp(join(tmpdir(), 'dsh-sftp-read-'))
    const target = join(dir, 'object')
    try {
      await this.#run(request, `get ${this.#quote(path)} ${this.#quote(target)}`)
      const content = await readFile(target)
      const bounded = content.subarray(0, request.request.maxBytes)
      return { data: { path, bytes: bounded.byteLength, content: bounded.toString('utf8') }, truncated: content.byteLength > bounded.byteLength }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  #quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
  async #run(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, command: string): Promise<string> {
    const { username, privateKey } = credentials(request.credential)
    const { host, port = 22, knownHostsPath } = request.source.connection!
    const keyDir = await mkdtemp(join(tmpdir(), 'dsh-sftp-key-')); const keyFile = join(keyDir, 'id')
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 })
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = spawn('sftp', ['-q', '-P', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-i', keyFile, `${username}@${host}`])
        let stdout = ''; let stderr = ''
        child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => { stdout += data })
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { stderr += data })
        child.once('error', reject); child.once('close', code => code === 0 ? resolve({ stdout }) : reject(new Error(stderr || `exit ${code}`)))
        child.stdin.end(`${command}\nquit\n`)
      })
      return stdout
    } catch (error) { throw new Error(`data-sources: SFTP operation failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await rm(keyDir, { recursive: true, force: true }) }
  }
}

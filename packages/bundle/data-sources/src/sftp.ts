/* oxlint-disable typescript/no-non-null-assertion -- guardRead concretizes budgets before dispatch. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

/** Uses OpenSSH in strict known-host mode; ephemeral credential and bounded download paths are removed after every operation. */
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
    const { content, truncated } = await this.#download(request, path, request.request.maxBytes!)
    return { data: { path, bytes: content.byteLength, content: content.toString('utf8') }, truncated }
  }

  #quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
  #args(host: string, port: number, knownHostsPath: string, keyFile: string, username: string): string[] {
    return ['-q', '-b', '-', '-P', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-i', keyFile, `${username}@${host}`]
  }

  async #run(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, command: string): Promise<string> {
    const { username, privateKey } = credentials(request.credential)
    const { host, port = 22, knownHostsPath } = request.source.connection!
    const keyDir = await mkdtemp(join(tmpdir(), 'dsh-sftp-key-')); const keyFile = join(keyDir, 'id')
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 })
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = spawn('sftp', this.#args(host!, port, knownHostsPath!, keyFile, username), { env: { PATH: process.env.PATH ?? '' } })
        const timeout = request.source.connection?.timeoutMs ?? 10_000
        let timedOut = false; let stdout = ''; let stderr = ''
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
        child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => { stdout += data })
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { stderr += data })
        child.once('error', reject); child.once('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve({ stdout })
          else if (timedOut) reject(new Error(`data-sources: SFTP operation timed out after ${timeout}ms`))
          else reject(new Error(stderr || `exit ${code}`))
        })
        child.stdin.end(`${command}\n`)
      })
      return stdout
    } catch (error) { throw new Error(`data-sources: SFTP operation failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await rm(keyDir, { recursive: true, force: true }) }
  }

  /** RLIMIT_FSIZE limits a regular local target to the requested bytes plus one truncation sentinel. */
  async #download(request: ConnectorRequest, path: string, maxBytes: number): Promise<{ content: Buffer; truncated: boolean }> {
    const { username, privateKey } = credentials(request.credential)
    const { host, port = 22, knownHostsPath } = request.source.connection!
    const root = await mkdtemp(join(tmpdir(), 'dsh-sftp-read-')); const keyFile = join(root, 'id'); const target = join(root, 'object')
    const limit = maxBytes + 1
    const timeout = request.source.connection?.timeoutMs ?? 10_000
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 })
      const result = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
        const child = spawn('prlimit', [`--fsize=${limit}:${limit}`, '--', 'sftp', ...this.#args(host!, port, knownHostsPath!, keyFile, username)], { env: { PATH: process.env.PATH ?? '' } })
        let timedOut = false; let stderr = ''
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { stderr += data })
        child.stdout.resume(); child.once('error', reject); child.once('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }) })
        child.stdin.end(`get ${this.#quote(path)} ${this.#quote(target)}\n`)
      })
      const size = await stat(target).then(value => value.size).catch(() => 0)
      if (size < limit && result.code !== 0) {
        if (result.timedOut) throw new Error(`data-sources: SFTP operation timed out after ${timeout}ms`)
        throw new Error(result.stderr || `exit ${result.code}`)
      }
      const content = await readFile(target)
      return { content: content.subarray(0, maxBytes), truncated: size >= limit }
    } catch (error) { throw new Error(`data-sources: SFTP operation failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await rm(root, { recursive: true, force: true }) }
  }
}

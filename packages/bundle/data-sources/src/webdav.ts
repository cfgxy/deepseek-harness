/* oxlint-disable typescript/no-non-null-assertion -- guardRead concretizes budgets before dispatch. */
import { posix } from 'node:path'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

function credentials(value: string | undefined): { username: string; password: string } {
  if (value === undefined) throw new Error('data-sources: WebDAV credential is required')
  try {
    const raw = JSON.parse(value) as Record<string, unknown>
    if (typeof raw.username === 'string' && raw.username !== '' && typeof raw.password === 'string') return { username: raw.username, password: raw.password }
  } catch {}
  throw new Error('data-sources: WebDAV credential must be JSON with username and password')
}

async function readAtMost(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (response.body === null) return { body: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []; let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return { body: Buffer.concat(chunks), truncated: false }
      const chunk = Buffer.from(next.value)
      const remaining = maxBytes + 1 - size
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      size += chunk.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return { body: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true }
      }
    }
  } finally { reader.releaseLock() }
}

function responseHrefs(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?href\b[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/gi)]
    .map(match => match[1]!.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
}

/** Reads WebDAV collections with PROPFIND and objects with GET; non-read methods are never issued. */
export class WebDavConnector implements ReadConnector {
  readonly kind = 'webdav' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> {
    const response = await this.#request(request, request.source.policy.allowedPath!, 'PROPFIND', { depth: '0' })
    if (response.status !== 207) throw new Error(`data-sources: WebDAV probe failed (${response.status})`)
    await response.body?.cancel()
  }

  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const path = String(request.request.input.path)
    if (request.request.operation === 'directory.list') {
      const response = await this.#request(request, path, 'PROPFIND', { depth: '1' })
      if (response.status !== 207) throw new Error(`data-sources: WebDAV directory listing failed (${response.status})`)
      const { body, truncated: upstreamTruncated } = await readAtMost(response, request.request.maxBytes!)
      const collection = this.#url(request.source.connection!.endpoint!, path).pathname.replace(/\/$/, '')
      const entries: string[] = []; let bytes = 2; let truncated = upstreamTruncated
      for (const href of responseHrefs(body.toString('utf8'))) {
        let candidate: URL
        try { candidate = new URL(href, request.source.connection!.endpoint) } catch { continue }
        const target = candidate.pathname.replace(/\/$/, '')
        if (!target.startsWith(`${collection}/`)) continue
        const name = decodeURIComponent(posix.basename(target))
        if (name === '' || name.includes('/') || name === '.' || name === '..') continue
        const size = Buffer.byteLength(JSON.stringify(name)) + (entries.length ? 1 : 0)
        if (entries.length === request.request.maxRows! || bytes + size > request.request.maxBytes!) { truncated = true; break }
        entries.push(name); bytes += size
      }
      return { data: { path, entries }, truncated }
    }
    const response = await this.#request(request, path, 'GET', { range: `bytes=0-${request.request.maxBytes!}` })
    if (!response.ok) throw new Error(`data-sources: WebDAV object read failed (${response.status})`)
    const { body, truncated } = await readAtMost(response, request.request.maxBytes!)
    return { data: { path, bytes: body.byteLength, content: body.toString('utf8') }, truncated }
  }

  #url(endpoint: string, path: string): URL {
    const url = new URL(endpoint)
    const base = url.pathname.replace(/\/$/, '')
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    url.pathname = `${base}${encoded.startsWith('/') ? encoded : `/${encoded}`}`
    return url
  }

  async #request(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, path: string, method: 'GET' | 'PROPFIND', headers: Record<string, string>): Promise<Response> {
    const { username, password } = credentials(request.credential)
    const timeout = request.source.connection?.timeoutMs ?? 10_000
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeout)
    try {
      return await fetch(this.#url(request.source.connection!.endpoint!, path), {
        method, headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...headers }, signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`data-sources: WebDAV operation timed out after ${timeout}ms`)
      throw error
    } finally { clearTimeout(timer) }
  }
}

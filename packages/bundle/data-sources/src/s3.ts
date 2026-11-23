/* oxlint-disable typescript/no-non-null-assertion, @stylistic/max-len -- S3 response parsing uses checked connector config and bounded fields. */
import { createHmac, createHash } from 'node:crypto'
import type { ConnectorRequest, ReadConnector } from './supervisor.ts'
import type { ReadResult } from './types.ts'

function credential(value: string | undefined): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  if (value === undefined) throw new Error('data-sources: S3 credential is required')
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (typeof parsed.accessKeyId === 'string' && typeof parsed.secretAccessKey === 'string') return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, ...(typeof parsed.sessionToken === 'string' ? { sessionToken: parsed.sessionToken } : {}) }
  } catch {}
  throw new Error('data-sources: S3 credential must be JSON with accessKeyId and secretAccessKey')
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest()
function encodeKey(key: string): string { return key.split('/').map(encodeURIComponent).join('/') }

/** Minimal SigV4 S3-compatible reader. It deliberately exposes no put/delete/copy operation. */
export class S3Connector implements ReadConnector {
  readonly kind = 's3' as const
  async probe(request: Omit<ConnectorRequest, 'request'>): Promise<void> {
    const response = await this.#request(request, '', 'list-type=2&max-keys=1')
    if (!response.ok) throw new Error(`data-sources: S3 probe failed (${response.status})`)
  }
  async execute(request: ConnectorRequest): Promise<Omit<ReadResult, 'source' | 'evidence'>> {
    const key = String(request.request.input.path)
    if (request.request.operation === 'catalog') {
      const prefix = String(request.source.policy.allowedPrefix)
      const response = await this.#request(request, '', `list-type=2&prefix=${encodeURIComponent(prefix)}`)
      if (!response.ok) throw new Error(`data-sources: S3 catalog failed (${response.status})`)
      const xml = await response.text()
      const listed = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(x => x[1]!)
      const keys: string[] = []; let bytes = 2; let truncated = false
      for (const key of listed) {
        const size = Buffer.byteLength(JSON.stringify(key)) + (keys.length ? 1 : 0)
        if (keys.length === request.request.maxRows! || bytes + size > request.request.maxBytes!) { truncated = true; break }
        keys.push(key); bytes += size
      }
      return { data: { keys }, truncated: truncated || listed.length > keys.length }
    }
    const response = await this.#request(request, key)
    if (!response.ok) throw new Error(`data-sources: S3 object read failed (${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const bounded = bytes.subarray(0, request.request.maxBytes)
    return { data: { path: key, bytes: bounded.byteLength, content: new TextDecoder().decode(bounded) }, truncated: bytes.byteLength > bounded.byteLength }
  }
  async #request(request: Omit<ConnectorRequest, 'request'> | ConnectorRequest, key: string, query = ''): Promise<Response> {
    const { endpoint, bucket, region = 'us-east-1' } = request.source.connection!
    const credentials = credential(request.credential)
    const base = new URL(endpoint!)
    const canonicalUri = `/${encodeURIComponent(bucket!)}/${encodeKey(key)}`.replace(/\/$/, key === '' ? '/' : '')
    const url = new URL(canonicalUri, base)
    url.search = query
    const now = new Date(); const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const date = stamp.slice(0, 8)
    const payloadHash = sha('')
    const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp }
    if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
    const signed = Object.keys(headers).sort()
    const canonicalHeaders = signed.map(key => `${key}:${headers[key]}\n`).join('')
    const canonical = `GET\n${canonicalUri}\n${query}\n${canonicalHeaders}\n${signed.join(';')}\n${payloadHash}`
    const scope = `${date}/${region}/s3/aws4_request`
    const signing = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), 's3'), 'aws4_request')
    const signature = createHmac('sha256', signing).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha(canonical)}`).digest('hex')
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
    return fetch(url, { headers })
  }
}

/** Host-only Pa诺云 account and Sub2API key operations. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Fixed public API origin; the Pa诺云 browser panel is deliberately not an API target. */
export const PANUOYUN_API_ORIGIN = 'https://api.apinoria.com'
/** JWT stays in the Host credential store and is never exposed to the renderer. */
export const PANUOYUN_JWT_REF = credentialRef('PANUOYUN_JWT')
/** The one explicit or newly-created key selected for the Harness provider. */
export const PANUOYUN_API_KEY_REF = credentialRef('PANUOYUN_API_KEY')

/** Safe fields of a Sub2API group. */
export interface PanuoyunGroup {
  readonly id: string
  readonly name: string
}

/** A selected-key model. No upstream response body is retained after projection. */
export interface PanuoyunModel {
  readonly id: string
}

/** Response failure that deliberately contains no request or credential payload. */
export class PanuoyunError extends Error {
  /** @param operation - stable failed operation name. @param status - upstream HTTP status. */
  constructor(readonly operation: string, readonly status: number) {
    super(`Pa诺云 ${operation} failed (HTTP ${String(status)})`)
  }
}

/** Host-owned account operations. Every network call is made from this process, never from app://. */
export class PanuoyunAccount extends TypertRemoteService {
  static inject = ['credentials']
  constructor(ctx: Context) { super(ctx, 'panuoyunAccount', { namespace: 'panuoyun' }) }

  /** Authenticate with Pa诺云 and replace only the stored JWT after a successful response. */
  @Remote
  async login(username: string, password: string): Promise<void> {
    const response = await fetch(`${PANUOYUN_API_ORIGIN}/api/v1/auth/login`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new PanuoyunError('login', response.status)
    const token = tokenOf(payload)
    if (token === undefined) throw new PanuoyunError('login', response.status)
    await this.ctx.credentials.set(PANUOYUN_JWT_REF, token)
  }

  /** Read groups with the JWT, removing an expired local JWT on a 401 response. */
  @Remote
  async groups(): Promise<readonly PanuoyunGroup[]> {
    const response = await this.authorized('/api/v1/groups/available', 'groups')
    const payload: unknown = await response.json().catch(() => undefined)
    if (!Array.isArray(payload)) return []
    return payload.flatMap(groupOf)
  }

  /** Store an explicitly typed/selected key only after it passes `/v1/models`. */
  @Remote
  async selectApiKey(key: string): Promise<readonly PanuoyunModel[]> {
    if (key.length === 0) throw new TypeError('Pa诺云 API key must not be empty')
    const models = await this.requestModels(key)
    await this.ctx.credentials.set(PANUOYUN_API_KEY_REF, key)
    return models
  }

  /** Create a dedicated key with the JWT, then verify and store the returned one without listing existing keys. */
  @Remote
  async createApiKey(name: string, group?: string): Promise<readonly PanuoyunModel[]> {
    const response = await this.authorized('/api/v1/keys', 'create-key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(group === undefined ? {} : { group }) }),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const key = keyOf(payload)
    if (key === undefined) throw new PanuoyunError('create-key', response.status)
    return await this.selectApiKey(key)
  }

  /** Discover models through the selected API key; a rejected key is removed locally. */
  @Remote
  async models(): Promise<readonly PanuoyunModel[]> {
    const selected = await this.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)
    if (selected === undefined) return []
    return await this.requestModels(selected.value)
  }

  /** Sign out locally without exposing either secret or asking the browser to clear it. */
  @Remote
  async signOut(): Promise<void> {
    await Promise.all([this.ctx.credentials.unset(PANUOYUN_JWT_REF), this.ctx.credentials.unset(PANUOYUN_API_KEY_REF)])
  }

  private async authorized(path: string, operation: string, init: RequestInit = {}): Promise<Response> {
    const jwt = await this.ctx.credentials.resolve(PANUOYUN_JWT_REF)
    if (jwt === undefined) throw new PanuoyunError(operation, 401)
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('authorization', `Bearer ${jwt.value}`)
    const response = await fetch(`${PANUOYUN_API_ORIGIN}${path}`, { ...init, headers })
    if (response.status === 401) await this.ctx.credentials.unset(PANUOYUN_JWT_REF)
    if (!response.ok) throw new PanuoyunError(operation, response.status)
    return response
  }

  private async requestModels(key: string): Promise<readonly PanuoyunModel[]> {
    const response = await fetch(`${PANUOYUN_API_ORIGIN}/v1/models`, { headers: { accept: 'application/json', authorization: `Bearer ${key}` } })
    if (response.status === 401) await this.ctx.credentials.unset(PANUOYUN_API_KEY_REF)
    if (!response.ok) throw new PanuoyunError('models', response.status)
    const payload: unknown = await response.json().catch(() => undefined)
    const entries = isObject(payload) && Array.isArray(payload.data) ? payload.data : []
    return entries.flatMap(modelOf)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { panuoyunAccount: PanuoyunAccount } }

/** Extract a token from documented and deployed login response wrappers. */
function tokenOf(value: unknown): string | undefined {
  const candidates = [value, isObject(value) ? value.data : undefined]
  for (const candidate of candidates) if (isObject(candidate) && typeof candidate.token === 'string' && candidate.token.length > 0) return candidate.token
  return undefined
}

/** Extract a key only from the create response, never from the key-list endpoint. */
function keyOf(value: unknown): string | undefined {
  const candidates = [value, isObject(value) ? value.data : undefined]
  for (const candidate of candidates) if (isObject(candidate) && typeof candidate.key === 'string' && candidate.key.length > 0) return candidate.key
  return undefined
}
function groupOf(value: unknown): PanuoyunGroup[] {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return []
  return [{ id: value.id, name: value.name }]
}
function modelOf(value: unknown): PanuoyunModel[] {
  if (!isObject(value) || typeof value.id !== 'string') return []
  return [{ id: value.id }]
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export default PanuoyunAccount

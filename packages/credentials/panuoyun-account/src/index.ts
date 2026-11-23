/** Host-only Pa诺云 account and Sub2API key operations. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PanuoyunGroup, PanuoyunModel } from './types.ts'
export type { PanuoyunGroup, PanuoyunModel } from './types.ts'

/** Personal and enterprise Pa诺云 deployments use disjoint fixed API origins. */
export type PanuoyunMode = 'personal' | 'enterprise'
/** Personal control and inference origin. */
export const PANUOYUN_PERSONAL_API_ORIGIN = 'https://api.apinoria.com'
/** Enterprise control and inference origin, never derived from a login-origin input. */
export const PANUOYUN_ENTERPRISE_API_ORIGIN = 'https://api.ainoriahub.com'
/** Pa诺云 configuration stored in the profile's non-secret settings section. */
export interface Config {
  /** Personal is the first-run default; enterprise needs a separately validated login origin. */
  mode: Volatile<PanuoyunMode>
  /** Enterprise-only origin used exclusively for its login request. */
  enterpriseLoginOrigin: Volatile<string>
}
export const Config = z.object({
  mode: z.union(['personal', 'enterprise'] as const).default('personal').volatile(),
  enterpriseLoginOrigin: z.string().default('').volatile(),
})
/** Resolve the deployment-controlled API origin. */
export function apiOriginFor(mode: PanuoyunMode): string {
  return mode === 'personal' ? PANUOYUN_PERSONAL_API_ORIGIN : PANUOYUN_ENTERPRISE_API_ORIGIN
}
/**
 * Validate the user-provided enterprise login origin before the Host can fetch it.
 * @param value - non-secret profile setting.
 * @returns canonical allowed HTTPS origin.
 */
export function enterpriseLoginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError('Pa诺云 enterprise login origin must be an absolute HTTPS URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || url.port || !url.hostname.endsWith('.ainoriahub.com')) {
    throw new TypeError('Pa诺云 enterprise login origin must be an HTTPS .ainoriahub.com origin without path, credentials, query, fragment, or port')
  }
  return url.origin
}

/** Backward-compatible personal API origin alias. */
export const PANUOYUN_API_ORIGIN = PANUOYUN_PERSONAL_API_ORIGIN
/** JWT stays in the Host credential store and is never exposed to the renderer. */
export const PANUOYUN_JWT_REF = credentialRef('PANUOYUN_JWT')
/** The one explicit or newly-created key selected for the Harness provider. */
export const PANUOYUN_API_KEY_REF = credentialRef('PANUOYUN_API_KEY')

/** Route name and credential reference reserved for the one selected Pa诺云 key. */
export const PANUOYUN_PROVIDER = 'panuoyun'
export const PANUOYUN_LLM_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Response failure that deliberately contains no request or credential payload. */
export class PanuoyunError extends Error {
  /** @param operation - stable failed operation name. @param status - upstream HTTP status. */
  constructor(readonly operation: string, readonly status: number) {
    super(`Pa诺云 ${operation} failed (HTTP ${String(status)})`)
  }
}

/** Host-owned account operations. Every network call is made from this process, never from app://. */
export class PanuoyunAccount extends TypertRemoteService {
  static inject = ['credentials', 'settings']
  static Config = Config
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'panuoyunAccount', { namespace: 'panuoyun' }) }

  /** Authenticate with the configured Pa诺云 mode and replace only the stored JWT after a successful response. */
  @Remote
  async login(email: string, password: string): Promise<void> {
    const connection = this.connection()
    const response = await fetch(`${connection.loginOrigin}/api/v1/auth/login`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
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
    const groups = isObject(payload) && Array.isArray(payload.data) ? payload.data : []
    return groups.flatMap(groupOf)
  }

  /** Store an explicitly typed/selected key only after it passes `/v1/models`. */
  @Remote
  async selectApiKey(key: string): Promise<readonly PanuoyunModel[]> {
    if (key.length === 0) throw new TypeError('Pa诺云 API key must not be empty')
    const models = await this.requestModels(key)
    await this.configureProvider(models)
    try {
      await this.ctx.credentials.set(PANUOYUN_API_KEY_REF, key)
    } catch (error) {
      await this.restoreProvider().catch(() => undefined)
      throw error
    }
    return models
  }

  /** Create a dedicated key with the JWT, then verify and store the returned one without listing existing keys. */
  @Remote
  async createApiKey(name: string, groupId?: number): Promise<readonly PanuoyunModel[]> {
    const response = await this.authorized('/api/v1/keys', 'create-key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(groupId === undefined ? {} : { group_id: groupId }) }),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const key = keyOf(payload)
    if (key === undefined) throw new PanuoyunError('create-key', response.status)
    return await this.selectApiKey(key)
  }

  /** Discover models through the selected API key; failures preserve the last known-good key and route. */
  @Remote
  async models(): Promise<readonly PanuoyunModel[]> {
    const selected = await this.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)
    if (selected === undefined) return []
    const models = await this.requestModels(selected.value)
    await this.configureProvider(models)
    return models
  }

  /** Sign out locally without exposing either secret or asking the browser to clear it. */
  @Remote
  async signOut(): Promise<void> {
    const remove = this.removeProvider()
    await Promise.all([this.ctx.credentials.unset(PANUOYUN_JWT_REF), this.ctx.credentials.unset(PANUOYUN_API_KEY_REF)])
    await remove
  }

  /** Resolve one operation's fixed API origin and its separately scoped login origin. */
  private connection(): { apiOrigin: string; loginOrigin: string } {
    const mode = this.config.mode.get()
    if (mode === 'personal') return { apiOrigin: PANUOYUN_PERSONAL_API_ORIGIN, loginOrigin: PANUOYUN_PERSONAL_API_ORIGIN }
    return { apiOrigin: PANUOYUN_ENTERPRISE_API_ORIGIN, loginOrigin: enterpriseLoginOrigin(this.config.enterpriseLoginOrigin.get()) }
  }

  private async authorized(path: string, operation: string, init: RequestInit = {}): Promise<Response> {
    const jwt = await this.ctx.credentials.resolve(PANUOYUN_JWT_REF)
    if (jwt === undefined) throw new PanuoyunError(operation, 401)
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('authorization', `Bearer ${jwt.value}`)
    const response = await fetch(`${this.connection().apiOrigin}${path}`, { ...init, headers })
    if (response.status === 401) await this.ctx.credentials.unset(PANUOYUN_JWT_REF)
    if (!response.ok) throw new PanuoyunError(operation, response.status)
    return response
  }

  /** Write the validated discovery result as one profile while preserving explicit model fields a user already saved. */
  private async configureProvider(models: readonly PanuoyunModel[]): Promise<void> {
    const descriptor = this.settingsDescriptor()
    const current = providerProfile(descriptor?.value) ?? {}
    const previous = providerProfile(descriptor?.user)
    const profile = {
      ...current,
      displayName: typeof current.displayName === 'string' ? current.displayName : '派诺云',
      apiKeyEnv: String(PANUOYUN_API_KEY_REF),
      api: 'openai-completions',
      baseURL: `${this.connection().apiOrigin}/v1`,
      models: mergeModels(current.models, models),
    }
    this.providerBeforeWrite = previous
    await this.ctx.settings.mutate(PANUOYUN_LLM_SETTINGS_NAMESPACE, [{
      op: 'set', path: ['providers', PANUOYUN_PROVIDER], value: profile,
    }])
  }

  /** Remove the route owned by this integration before dropping its credential. */
  private async removeProvider(): Promise<void> {
    await this.ctx.settings.mutate(PANUOYUN_LLM_SETTINGS_NAMESPACE, [{
      op: 'unset', path: ['providers', PANUOYUN_PROVIDER],
    }])
  }

  /** Roll back the exact previous user-level route if credential persistence fails after a settings write. */
  private async restoreProvider(): Promise<void> {
    const previous = this.providerBeforeWrite
    const op: SettingsPathOp = previous === undefined
      ? { op: 'unset', path: ['providers', PANUOYUN_PROVIDER] }
      : { op: 'set', path: ['providers', PANUOYUN_PROVIDER], value: previous }
    await this.ctx.settings.mutate(PANUOYUN_LLM_SETTINGS_NAMESPACE, [op])
  }

  private providerBeforeWrite: Record<string, unknown> | undefined

  private settingsDescriptor(): SettingsDescriptor | undefined {
    return this.ctx.settings.describe().find(entry => entry.ns === PANUOYUN_LLM_SETTINGS_NAMESPACE)
  }

  private async requestModels(key: string): Promise<readonly PanuoyunModel[]> {
    const response = await fetch(`${this.connection().apiOrigin}/v1/models`, { headers: { accept: 'application/json', authorization: `Bearer ${key}` } })
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
  for (const candidate of candidates) if (isObject(candidate) && typeof candidate.access_token === 'string' && candidate.access_token.length > 0) return candidate.access_token
  return undefined
}

/** Extract a key only from the create response, never from the key-list endpoint. */
function keyOf(value: unknown): string | undefined {
  const candidates = [value, isObject(value) ? value.data : undefined]
  for (const candidate of candidates) if (isObject(candidate) && typeof candidate.key === 'string' && candidate.key.length > 0) return candidate.key
  return undefined
}
function groupOf(value: unknown): PanuoyunGroup[] {
  if (!isObject(value) || (typeof value.id !== 'number' && typeof value.id !== 'string') || typeof value.name !== 'string') return []
  return [{ id: String(value.id), name: value.name }]
}
function modelOf(value: unknown): PanuoyunModel[] {
  if (!isObject(value) || typeof value.id !== 'string') return []
  return [{ id: value.id }]
}

/** Pull only the existing Pa诺云 profile from a redacted settings descriptor. */
function providerProfile(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) || !isObject(value.providers) || !isObject(value.providers[PANUOYUN_PROVIDER])) return undefined
  return structuredClone(value.providers[PANUOYUN_PROVIDER])
}

/** Existing entries carry any user override; unknown discovered models remain declaration-minimal. */
function mergeModels(existing: unknown, discovered: readonly PanuoyunModel[]): Array<Record<string, unknown>> {
  const saved = Array.isArray(existing) ? existing.filter(isModelProfile) : []
  const byId = new Map(saved.map(model => [model.id, model]))
  for (const model of discovered) if (!byId.has(model.id)) byId.set(model.id, { id: model.id })
  return [...byId.values()]
}
function isModelProfile(value: unknown): value is Record<string, unknown> & { id: string } {
  return isObject(value) && typeof value.id === 'string'
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export default PanuoyunAccount

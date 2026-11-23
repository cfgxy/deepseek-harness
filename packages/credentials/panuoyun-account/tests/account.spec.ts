import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import {
  PANUOYUN_API_KEY_REF, PANUOYUN_JWT_REF, PanuoyunAccount, PanuoyunError,
  enterpriseLoginOrigin,
} from '../src/index.ts'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function mount(
  seed: Record<string, string> = {},
  config: { mode?: 'personal' | 'enterprise'; enterpriseLoginOrigin?: string } = {},
  configuredProvider: Record<string, unknown> = {},
) {
  const ctx = new Context()
  const settings = {
    value: { providers: { ...configuredProvider } },
    user: { providers: { ...configuredProvider } },
    mutations: [] as Array<unknown>,
  }
  ctx.provide('settings', {
    describe: () => [{ ns: 'llm-pi-ai', value: settings.value, user: settings.user }],
    mutate: async (_ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) => {
      settings.mutations.push(ops)
      for (const op of ops) {
        if (op.op === 'set') settings.value.providers.panuoyun = structuredClone(op.value)
        else delete settings.value.providers.panuoyun
        if (op.op === 'set') settings.user.providers.panuoyun = structuredClone(op.value)
        else delete settings.user.providers.panuoyun
      }
    },
  } as never)
  await ctx.plugin(MemoryCredentials, seed)
  const fiber = await ctx.plugin(PanuoyunAccount, config)
  return { ctx, account: ctx.panuoyunAccount, settings, dispose: () => fiber.dispose() }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('PanuoyunAccount', () => {
  it('stores an access_token login envelope in Host credentials without returning it', async () => {
    const fetch = vi.fn(async () => response(200, { code: 0, data: { access_token: 'jwt-secret' } }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount()

    await expect(test.account.login('member@example.com', 'password-secret')).resolves.toBeUndefined()
    await expect(test.ctx.credentials.resolve(PANUOYUN_JWT_REF)).resolves.toMatchObject({ value: 'jwt-secret' })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.apinoria.com/api/v1/auth/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'password-secret' }) }),
    )
    await test.dispose()
  })

  it('clears an expired JWT after a protected group request and never sends it to the caller', async () => {
    const fetch = vi.fn(async () => response(401, { error: 'expired' }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'jwt-secret' })

    await expect(test.account.groups()).rejects.toEqual(expect.objectContaining({ operation: 'groups', status: 401 }))
    await expect(test.ctx.credentials.resolve(PANUOYUN_JWT_REF)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith('https://api.apinoria.com/api/v1/groups/available', expect.any(Object))
    await test.dispose()
  })

  it('uses the selected key only for the model probe and clears it on rejection', async () => {
    const fetch = vi.fn(async () => response(401, { error: 'invalid key' }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_API_KEY: 'selected-secret' })

    await expect(test.account.models()).rejects.toEqual(expect.objectContaining({ operation: 'models', status: 401 }))
    expect(fetch).toHaveBeenCalledWith(
      'https://api.apinoria.com/v1/models',
      expect.any(Object),
    )
    await expect(test.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)).resolves.toBeUndefined()
    expect(test.settings.value.providers.panuoyun).toBeUndefined()
    await test.dispose()
  })

  it('atomically saves the personal route only after selected-key model discovery', async () => {
    const fetch = vi.fn(async () => response(200, { data: [{ id: 'gpt-5.6-terra' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount()

    await expect(test.account.selectApiKey('selected-secret')).resolves.toEqual([{ id: 'gpt-5.6-terra' }])
    expect(test.settings.value.providers.panuoyun).toEqual({
      displayName: '派诺云', apiKeyEnv: 'PANUOYUN_API_KEY', api: 'openai-completions',
      baseURL: 'https://api.apinoria.com/v1', models: [{ id: 'gpt-5.6-terra' }],
    })
    expect(JSON.stringify(test.settings.value)).not.toContain('selected-secret')
    await test.dispose()
  })

  it('rolls back the route if saving a verified key fails', async () => {
    const fetch = vi.fn(async () => response(200, { data: [{ id: 'model-a' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount()
    vi.spyOn(test.ctx.credentials, 'set').mockRejectedValueOnce(new Error('credential disk unavailable'))

    await expect(test.account.selectApiKey('selected-secret')).rejects.toThrow('credential disk unavailable')
    expect(test.settings.value.providers.panuoyun).toBeUndefined()
    await test.dispose()
  })

  it('refreshes the enterprise route without overwriting a saved model override', async () => {
    const fetch = vi.fn(async () => response(200, { data: [{ id: 'gpt-5.6-terra' }, { id: 'model-new' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_API_KEY: 'selected-secret' }, {
      mode: 'enterprise', enterpriseLoginOrigin: 'https://tenant.ainoriahub.com',
    }, { panuoyun: { models: [{ id: 'gpt-5.6-terra', input: ['text', 'image'] }] } })

    await expect(test.account.models()).resolves.toEqual([{ id: 'gpt-5.6-terra' }, { id: 'model-new' }])
    expect(test.settings.value.providers.panuoyun).toMatchObject({
      apiKeyEnv: 'PANUOYUN_API_KEY', api: 'openai-completions', baseURL: 'https://api.ainoriahub.com/v1',
      models: [{ id: 'gpt-5.6-terra', input: ['text', 'image'] }, { id: 'model-new' }],
    })
    await test.dispose()
  })

  it('creates, verifies, and stores one dedicated key without calling the key-list endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    fetch.mockResolvedValueOnce(response(200, { code: 0, data: { key: 'new-key-secret' } }))
    fetch.mockResolvedValueOnce(response(200, { data: [{ id: 'gpt-5.6-terra' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'jwt-secret' })

    await expect(test.account.createApiKey('DeepSeek Harness', 42)).resolves.toEqual([{ id: 'gpt-5.6-terra' }])
    await expect(test.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)).resolves.toMatchObject({ value: 'new-key-secret' })
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.apinoria.com/api/v1/keys', expect.objectContaining({ body: JSON.stringify({ name: 'DeepSeek Harness', group_id: 42 }) }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.apinoria.com/v1/models', expect.any(Object))
    await test.dispose()
  })

  it('lists safe group and model identifiers, and logout removes both Host credentials', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { code: 0, data: [{ id: 42, name: 'Research' }] }))
      .mockResolvedValueOnce(response(200, { data: [{ id: 'model-a' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'jwt-secret', PANUOYUN_API_KEY: 'selected-secret' })

    await expect(test.account.groups()).resolves.toEqual([{ id: '42', name: 'Research' }])
    await expect(test.account.models()).resolves.toEqual([{ id: 'model-a' }])
    await test.account.signOut()
    await expect(test.ctx.credentials.resolve(PANUOYUN_JWT_REF)).resolves.toBeUndefined()
    await expect(test.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)).resolves.toBeUndefined()
    await test.dispose()
  })

  it('rejects a malformed login response without storing a JWT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { code: 0, data: {} })))
    const test = await mount()

    await expect(test.account.login('member@example.com', 'password-secret')).rejects.toBeInstanceOf(PanuoyunError)
    await expect(test.ctx.credentials.resolve(credentialRef('PANUOYUN_JWT'))).resolves.toBeUndefined()
    await test.dispose()
  })

  it('uses the personal API origin by default', async () => {
    const fetch = vi.fn(async () => response(200, { code: 0, data: { access_token: 'jwt-secret' } }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount()

    await test.account.login('member@example.com', 'password-secret')
    expect(fetch).toHaveBeenCalledWith('https://api.apinoria.com/api/v1/auth/login', expect.any(Object))
    await test.dispose()
  })

  it('uses the enterprise login origin only for login, preserving the fixed enterprise API origin', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { code: 0, data: { access_token: 'jwt-secret' } }))
      .mockResolvedValueOnce(response(200, { code: 0, data: [{ id: 7, name: 'Engineering' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'existing-jwt' }, {
      mode: 'enterprise', enterpriseLoginOrigin: 'https://tenant.ainoriahub.com',
    })

    await test.account.login('member@example.com', 'password-secret')
    await test.account.groups()
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://tenant.ainoriahub.com/api/v1/auth/login', expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.ainoriahub.com/api/v1/groups/available', expect.any(Object))
    await test.dispose()
  })

  it.each([
    'http://tenant.ainoriahub.com', 'https://ainoriahub.com', 'https://tenant.ainoriahub.com/path',
    'https://user@tenant.ainoriahub.com', 'https://tenant.ainoriahub.com?next=x',
    'https://127.0.0.1', 'https://localhost', 'https://tenant.example.com',
  ])('rejects unsafe enterprise login origin %s', (origin) => {
    expect(() => enterpriseLoginOrigin(origin)).toThrow(/enterprise login origin/)
  })

  it('accepts only a canonical HTTPS enterprise subdomain origin', () => {
    expect(enterpriseLoginOrigin('https://tenant.ainoriahub.com/')).toBe('https://tenant.ainoriahub.com')
  })
})

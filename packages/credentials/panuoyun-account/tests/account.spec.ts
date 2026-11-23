import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../credentials/tests/memory.ts'
import {
  PANUOYUN_API_KEY_REF, PANUOYUN_JWT_REF, PanuoyunAccount, PanuoyunError,
} from '../src/index.ts'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function mount(seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  const fiber = await ctx.plugin(PanuoyunAccount)
  return { ctx, account: ctx.panuoyunAccount, dispose: () => fiber.dispose() }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('PanuoyunAccount', () => {
  it('stores a successful login JWT in Host credentials without returning it', async () => {
    const fetch = vi.fn(async () => response(200, { data: { token: 'jwt-secret' } }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount()

    await expect(test.account.login('member@example.com', 'password-secret')).resolves.toBeUndefined()
    await expect(test.ctx.credentials.resolve(PANUOYUN_JWT_REF)).resolves.toMatchObject({ value: 'jwt-secret' })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.apinoria.com/api/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
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
    await test.dispose()
  })

  it('creates, verifies, and stores one dedicated key without calling the key-list endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    fetch.mockResolvedValueOnce(response(200, { data: { key: 'new-key-secret' } }))
    fetch.mockResolvedValueOnce(response(200, { data: [{ id: 'gpt-5.6-terra' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'jwt-secret' })

    await expect(test.account.createApiKey('DeepSeek Harness', 'research')).resolves.toEqual([{ id: 'gpt-5.6-terra' }])
    await expect(test.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)).resolves.toMatchObject({ value: 'new-key-secret' })
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.apinoria.com/api/v1/keys', expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.apinoria.com/v1/models', expect.any(Object))
    await test.dispose()
  })

  it('lists safe group and model identifiers, and logout removes both Host credentials', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, [{ id: 'research', name: 'Research' }]))
      .mockResolvedValueOnce(response(200, { data: [{ id: 'model-a' }] }))
    vi.stubGlobal('fetch', fetch)
    const test = await mount({ PANUOYUN_JWT: 'jwt-secret', PANUOYUN_API_KEY: 'selected-secret' })

    await expect(test.account.groups()).resolves.toEqual([{ id: 'research', name: 'Research' }])
    await expect(test.account.models()).resolves.toEqual([{ id: 'model-a' }])
    await test.account.signOut()
    await expect(test.ctx.credentials.resolve(PANUOYUN_JWT_REF)).resolves.toBeUndefined()
    await expect(test.ctx.credentials.resolve(PANUOYUN_API_KEY_REF)).resolves.toBeUndefined()
    await test.dispose()
  })

  it('does not store a malformed login response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { data: {} })))
    const test = await mount()

    await expect(test.account.login('member@example.com', 'password-secret')).rejects.toBeInstanceOf(PanuoyunError)
    await expect(test.ctx.credentials.resolve(credentialRef('PANUOYUN_JWT'))).resolves.toBeUndefined()
    await test.dispose()
  })
})

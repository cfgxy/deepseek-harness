import { describe, expect, it } from 'vitest'
import { resolveModelMetadata } from '../src/metadata.ts'
import { resolveRouteModels } from '../src/catalog.ts'

describe('provider-scoped model metadata', () => {
  it('uses installed catalog metadata only for its matching provider', () => {
    const metadata = resolveModelMetadata('openai', 'GPT_6_ASTRA')
    expect(metadata?.source).toBe('pi-ai-catalog')
    expect(metadata?.canonicalId).toBe('gpt-6-astra')
    expect(metadata?.input).toContain('image')
    expect(resolveModelMetadata('another-provider', 'gpt-6-astra')).toBeUndefined()
  })

  it('leaves unverified Pa诺云 model metadata unknown and preserves explicit user input', () => {
    expect(resolveModelMetadata('panuoyun', 'GPT_5.6_TERRA-2026-11-23')).toBeUndefined()
    const unknown = resolveRouteModels({
      provider: 'panuoyun', api: 'openai-completions', baseURL: 'https://api.apinoria.com/v1',
      models: [{ id: 'gpt-5.6-terra' }], defaultContextWindow: 1_000_000, defaultMaxTokens: 128_000, defaultInput: ['text'],
    })
    // The adapter's long-standing text fallback makes the route runnable; it
    // is not persisted catalog metadata or an image-capability assertion.
    expect(unknown.models[0]?.input).toEqual(['text'])
    const overridden = resolveRouteModels({
      provider: 'panuoyun', api: 'openai-completions', baseURL: 'https://api.apinoria.com/v1',
      models: [{ id: 'gpt-5.6-terra', input: ['text', 'image'] }], defaultContextWindow: 1_000_000, defaultMaxTokens: 128_000, defaultInput: ['text'],
    })
    expect(overridden.models[0]?.input).toEqual(['text', 'image'])
  })
})

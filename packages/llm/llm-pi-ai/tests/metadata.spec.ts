import { describe, expect, it } from 'vitest'
import { resolveModelMetadata } from '../src/metadata.ts'
import { resolveRouteModels } from '../src/catalog.ts'

describe('provider-scoped model metadata', () => {
  it('recognizes the Pa诺云 Terra alias and records its trusted image capability', () => {
    expect(resolveModelMetadata('panuoyun', 'GPT_5.6_TERRA-2026-11-23')).toEqual({
      source: 'panuoyun-catalog', canonicalId: 'gpt-5.6-terra', input: ['text', 'image'],
    })
    expect(resolveModelMetadata('another-provider', 'gpt-5.6-terra')).toBeUndefined()
  })

  it('materializes provider-scoped metadata without replacing an explicit user override', () => {
    const inferred = resolveRouteModels({
      provider: 'panuoyun', api: 'openai-completions', baseURL: 'https://api.apinoria.com/v1',
      models: [{ id: 'gpt-5.6-terra' }], defaultContextWindow: 1_000_000, defaultMaxTokens: 128_000, defaultInput: ['text'],
    })
    expect(inferred.models[0]?.input).toEqual(['text', 'image'])
    const overridden = resolveRouteModels({
      provider: 'panuoyun', api: 'openai-completions', baseURL: 'https://api.apinoria.com/v1',
      models: [{ id: 'gpt-5.6-terra', input: ['text'] }], defaultContextWindow: 1_000_000, defaultMaxTokens: 128_000, defaultInput: ['text'],
    })
    expect(overridden.models[0]?.input).toEqual(['text'])
  })
})

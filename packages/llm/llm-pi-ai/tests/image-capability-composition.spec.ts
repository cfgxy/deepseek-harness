import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { ImageCapabilityRegistryService } from '../../../bundle/image-iterate-plugin/src/capability.ts'
import * as PiAi from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  vi.unstubAllEnvs()
})

it('registers provider-owned image routes through the production plugin seam and disposes them with the fiber', async () => {
  vi.stubEnv('IMAGE_COMPOSITION_KEY', 'fixture-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const registry = new ImageCapabilityRegistryService()
  ctx.provide('imageCapabilities', registry)
  const provider = await ctx.plugin(PiAi, {
    providers: {
      gateway: {
        api: 'openai-completions',
        baseURL: 'https://gateway.test/v1',
        apiKeyEnv: 'IMAGE_COMPOSITION_KEY',
        models: [{ id: 'vision-current', input: ['text', 'image'] }],
        image: { model: 'image-model', reviewModel: 'review-fallback' },
      },
    },
  })

  expect(registry.list('gateway').map(capability => capability.model)).toEqual(['image-model'])
  expect(registry.listReviews('gateway').map(capability => capability.model).sort())
    .toEqual(['review-fallback', 'vision-current'])

  expect(registry.listReviews('gateway').find(route => route.model === 'review-fallback')?.preferred).toBe(true)
  await provider.dispose()
  expect(registry.list('gateway')).toEqual([])
  expect(registry.listReviews('gateway')).toEqual([])
})

it('discovers generation and review from an existing CPA model list without image configuration', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const registry = new ImageCapabilityRegistryService()
  ctx.provide('imageCapabilities', registry)
  const provider = await ctx.plugin(PiAi, {
    providers: {
      cpa: {
        api: 'openai-completions',
        baseURL: 'https://gateway.test/v1',
        models: [
          { id: 'gpt-image-2.6-flare', input: ['text', 'image'] },
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-image-2-copy' },
          { id: 'gpt-6.2-sol', input: ['text', 'image'] },
          { id: 'gpt-image-2' },
        ],
      },
      'variant-only': {
        api: 'openai-completions',
        baseURL: 'https://variant.test/v1',
        models: [{ id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-image-2.6-sunburst' }],
      },
      'review-only': {
        api: 'openai-completions',
        baseURL: 'https://review.test/v1',
        models: [
          { id: 'gpt-image-2-preview' },
          { id: 'vision', input: ['image', 'text'] },
        ],
      },
      'other-protocol': {
        api: 'anthropic-messages',
        baseURL: 'https://other.test',
        models: [{ id: 'gpt-image-2', input: ['text', 'image'] }],
      },
    },
  })

  expect(registry.list('cpa').map(route => route.model)).toEqual(['gpt-image-2'])
  expect(registry.listReviews('cpa').map(route => route.model)).toEqual(['gpt-6.2-sol'])
  expect(registry.list('variant-only').map(route => route.model)).toEqual(['gpt-image-2.6-sunburst'])
  expect(registry.listReviews('variant-only')).toEqual([])
  expect(registry.list('review-only')).toEqual([])
  expect(registry.listReviews('review-only').map(route => route.model)).toEqual(['vision'])
  expect(registry.list('other-protocol')).toEqual([])
  expect(registry.listReviews('other-protocol')).toEqual([])

  await provider.dispose()
  expect(registry.list('cpa')).toEqual([])
  expect(registry.listReviews('cpa')).toEqual([])
  expect(registry.listReviews('review-only')).toEqual([])
})

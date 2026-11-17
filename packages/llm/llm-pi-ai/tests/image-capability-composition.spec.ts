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

  await provider.dispose()
  expect(registry.list('gateway')).toEqual([])
  expect(registry.listReviews('gateway')).toEqual([])
})

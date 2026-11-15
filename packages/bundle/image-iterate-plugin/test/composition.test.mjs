import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.js'
import { provideImageCapabilityRegistry } from '../src/capability.js'

function config() {
  return {
    imageBaseUrl: '',
    imageModel: '',
    imageCredential: '',
    reviewBaseUrl: '',
    reviewModel: '',
    reviewCredential: '',
    maxIterations: 1,
    timeoutMs: 1000,
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    outputFormat: 'png',
  }
}

test('Cordis composition 使用当前 provider 路由并优先当前模型视觉审核', async () => {
  const ctx = new Context()
  const registry = provideImageCapabilityRegistry(ctx)
  const asked = []
  const calls = []
  let definition

  ctx.provide('tools', {
    register(value) {
      definition = value
      return () => { definition = undefined }
    },
  })
  ctx.provide('attachments', {
    saveImage: async ({ data, mediaType, name }) => ({
      attachmentId: 'sha256:composition-image',
      mediaType,
      bytes: data.length,
      width: 1,
      height: 1,
      name,
    }),
  })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('llm', {
    listModels: async provider => {
      assert.equal(provider, 'provider-a')
      return []
    },
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
    }),
  })
  ctx.provide('userQuestions', {
    ask: async request => {
      asked.push(request)
      return { answers: [{ id: request.questions[0].id, selected: ['image-route'] }] }
    },
  })

  const providerFiber = ctx.plugin({
    inject: ['imageCapabilities'],
    apply(scope) {
      scope.effect(() => scope.imageCapabilities.register({
        id: 'image-route',
        provider: 'provider-a',
        model: 'image-model',
        label: 'Provider image route',
        sizes: ['1024x1024'],
        qualities: ['medium'],
        generate: async request => {
          calls.push({ type: 'generate', request })
          return { bytes: Buffer.from('provider-image'), mimeType: 'image/png' }
        },
      }))
      scope.effect(() => scope.imageCapabilities.registerReview({
        id: 'review-current',
        provider: 'provider-a',
        model: 'chat-model',
        label: 'Current chat vision route',
        review: async request => {
          calls.push({ type: 'review', request })
          return { accepted: true, feedback: '符合标准' }
        },
      }))
    },
  })
  await providerFiber

  apply(ctx, config())
  assert.equal(typeof definition?.execute, 'function')

  const result = await definition.execute({
    prompt: 'a blue square',
    acceptance_criteria: 'must be blue',
  }, {
    agent: { model: { current: () => ({ provider: 'provider-a', model: 'chat-model' }) } },
    signal: new AbortController().signal,
  })

  assert.equal(result.accepted, true)
  assert.equal(result.image.attachmentId, 'sha256:composition-image')
  assert.equal(result.image.mediaType, 'image/png')
  assert.equal(result.image.width, 1)
  assert.equal(result.image.height, 1)
  assert.equal(asked.length, 0)
  assert.deepEqual(calls.map(call => call.type), ['generate', 'review'])
  assert.equal(calls[1].request.acceptanceCriteria, 'must be blue')

  const presentation = definition.presentResult({
    prompt: 'a blue square',
    acceptance_criteria: 'must be blue',
  }, { isError: false, meta: { image: result.image } })
  assert.deepEqual(presentation, { card: 'generic', content: [{ type: 'image', attachment: result.image }] })

  await providerFiber.dispose()
  assert.deepEqual(registry.list('provider-a'), [])
  assert.deepEqual(registry.listReviews('provider-a'), [])
})

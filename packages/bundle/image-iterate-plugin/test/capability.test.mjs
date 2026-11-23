import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  ImageCapabilityError,
  ImageCapabilityRegistryService,
  provideImageCapabilityRegistry,
  resolveImageCapability,
} from '../src/capability.ts'

function agent(selection = { provider: 'provider-a', model: 'model-a' }) {
  return { model: { current: () => selection } }
}

function capability(overrides = {}) {
  return {
    id: 'image-a',
    provider: 'provider-a',
    model: 'model-a',
    label: 'Provider A image capability',
    sizes: ['1024x1024'],
    qualities: ['medium'],
    generate: async () => ({ bytes: Buffer.from('image'), mimeType: 'image/png' }),
    review: async () => ({ accepted: true, feedback: 'ok' }),
    ...overrides,
  }
}

function context(candidates, answer) {
  const asked = []
  const imageCapabilities = { list: async () => candidates, listReviews: async () => [] }
  return {
    asked,
    imageCapabilities,
    get: service => service === 'imageCapabilities' ? imageCapabilities : undefined,
    userQuestions: {
      ask: async request => {
        asked.push(request)
        return typeof answer === 'function' ? answer(request) : answer
      },
    },
  }
}

function reviewCapability(overrides = {}) {
  return {
    id: 'review-a',
    provider: 'provider-a',
    model: 'vision-model',
    label: 'Provider A vision route',
    review: async () => ({ accepted: true, feedback: 'vision ok' }),
    ...overrides,
  }
}

test('唯一 exact capability 自动选择且不问询', async () => {
  const ctx = context([capability()])
  const result = await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-a')
  assert.equal(result.size, '1024x1024')
  assert.equal(result.quality, 'medium')
  assert.equal(ctx.asked.length, 0)
})

test('多个 exact capability 通过用户问询选择', async () => {
  const ctx = context([
    capability({ id: 'image-a' }),
    capability({ id: 'image-b', label: 'Provider B route' }),
  ], request => ({ answers: [{ id: request.questions[0].id, selected: ['image-b'] }] }))
  const result = await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-b')
  assert.deepEqual(ctx.asked[0].questions[0].options, [
    { label: 'image-a', description: 'Provider A image capability' },
    { label: 'image-b', description: 'Provider B route' },
  ])
})

test('当前模型没有 exact capability 时唯一 provider 候选自动选择且不问询', async () => {
  const ctx = context([capability({ model: 'other-model' })])
  const result = await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-a')
  assert.equal(ctx.asked.length, 0)
})

test('没有同 provider 的生图模型时直接报告，不询问无法选择的路由', async () => {
  const ctx = context([capability({ provider: 'other-provider' })])
  await assert.rejects(
    resolveImageCapability(ctx, agent(), '1024x1024', 'medium'),
    { code: 'CAPABILITY_UNAVAILABLE', message: /没有可用的生图模型/ },
  )
  assert.equal(ctx.asked.length, 0)
})

test('问询取消映射为 capability 取消错误', async () => {
  const ctx = context([capability(), capability({ id: 'image-b' })], async () => {
    throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
  })
  await assert.rejects(
    resolveImageCapability(ctx, agent(), '1024x1024', 'medium'),
    error => error instanceof ImageCapabilityError && error.code === 'CAPABILITY_SELECTION_CANCELLED',
  )
})

test('没有 answerer 映射为 capability 问询不可用', async () => {
  const ctx = context([capability(), capability({ id: 'image-b' })], async () => {
    throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
  })
  await assert.rejects(
    resolveImageCapability(ctx, agent(), '1024x1024', 'medium'),
    error => error instanceof ImageCapabilityError && error.code === 'CAPABILITY_SELECTION_UNAVAILABLE',
  )
})

test('空 size 和 quality 通过用户问询确定', async () => {
  const ctx = context([capability()], request => {
    const id = request.questions[0].id
    return { answers: [{ id, selected: [id === 'image-size' ? '1024x1024' : 'medium'] }] }
  })
  const result = await resolveImageCapability(ctx, agent(), '', '')
  assert.equal(result.size, '1024x1024')
  assert.equal(result.quality, 'medium')
  assert.deepEqual(ctx.asked.map(request => request.questions[0].id), ['image-size', 'image-quality'])
})

test('当前聊天模型声明 image 输入时优先使用当前模型视觉审核', async () => {
  const selected = capability({ model: 'image-model' })
  const currentReview = reviewCapability({ id: 'review-current', model: 'model-a' })
  const ctx = context([selected], request => ({
    answers: [{ id: request.questions[0].id, selected: ['image-a'] }],
  }), { inputModalities: ['text', 'image'] })
  ctx.imageCapabilities.listReviews = async () => [currentReview]
  const result = await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-a')
  assert.equal(result.review.id, 'review-current')
  assert.equal(ctx.asked.length, 0)
})

test('当前模型的 inline review 优先于非 exact 独立审核路由', async () => {
  const selected = capability({ model: 'image-model' })
  const otherReview = reviewCapability({ id: 'review-other', model: 'vision-model' })
  const ctx = context([selected], undefined, { inputModalities: ['text', 'image'] })
  ctx.imageCapabilities.listReviews = async () => [otherReview]
  const result = await resolveImageCapability(ctx, agent({ provider: 'provider-a', model: 'image-model' }), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-a')
  assert.equal(result.review.id, 'image-a')
  assert.equal(ctx.asked.length, 0)
})

test('文字聊天自动选择同 provider 的已注册视觉模型', async () => {
  const selected = capability({ provider: 'cpa', model: 'gpt-image-2', review: undefined })
  const ctx = context([selected])
  const vision = reviewCapability({ provider: 'cpa', model: 'gpt-6.2-sol' })
  ctx.imageCapabilities.listReviews = async provider => {
    assert.equal(provider, 'cpa')
    return [reviewCapability({ preferred: true }), vision]
  }
  const result = await resolveImageCapability(ctx, agent({ provider: 'cpa', model: 'gpt-5.6-sol' }), '1024x1024', 'medium')
  assert.equal(result.capability, selected)
  assert.equal(result.review, vision)
  assert.equal(ctx.asked.length, 0)
})

test('视觉审核优先用明确配置的回退模型，否则按注册顺序选择', async () => {
  const ctx = context([capability({ model: 'image-model', review: undefined })])
  const first = reviewCapability()
  const second = reviewCapability({ id: 'review-b', model: 'other-vision' })
  ctx.imageCapabilities.listReviews = async () => [first, second]
  assert.equal((await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')).review, first)
  const preferred = { ...second, preferred: true }
  ctx.imageCapabilities.listReviews = async () => [first, preferred]
  assert.equal((await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')).review, preferred)
  assert.equal(ctx.asked.length, 0)
})

test('没有本 provider 的审核模型时拒绝解析', async () => {
  const ctx = context([capability({ review: undefined })])
  ctx.imageCapabilities.listReviews = async () => [reviewCapability({ provider: 'other-provider' })]
  await assert.rejects(
    resolveImageCapability(ctx, agent(), '1024x1024', 'medium'),
    { code: 'CAPABILITY_UNAVAILABLE', message: /没有可用的视觉审核模型/ },
  )
  assert.equal(ctx.asked.length, 0)
})

test('各角色独立使用显式覆盖而不查询对应的自动路由', async () => {
  const imageOverride = capability({ model: 'private-img', review: undefined })
  const reviewOverride = reviewCapability({ model: 'private-vision' })
  const automaticReview = reviewCapability()
  const imageCtx = context([])
  imageCtx.imageCapabilities.list = () => assert.fail('must not resolve automatic generation')
  imageCtx.imageCapabilities.listReviews = async () => [automaticReview]
  const image = await resolveImageCapability(imageCtx, agent(), '1024x1024', 'medium', undefined, { imageOverride })
  assert.equal(image.capability, imageOverride)
  assert.equal(image.review, automaticReview)

  const automaticImage = capability({ review: undefined })
  const reviewCtx = context([automaticImage])
  reviewCtx.imageCapabilities.listReviews = () => assert.fail('must not resolve automatic review')
  const review = await resolveImageCapability(reviewCtx, agent(), '1024x1024', 'medium', undefined, { reviewOverride })
  assert.equal(review.capability, automaticImage)
  assert.equal(review.review, reviewOverride)
})

test('正式 registry 的 provider 注册随 Cordis effect 卸载', async () => {
  const ctx = new Context()
  const registry = provideImageCapabilityRegistry(ctx)
  assert.equal(registry instanceof ImageCapabilityRegistryService, true)
  const fiber = ctx.plugin({
    inject: ['imageCapabilities'],
    apply(scope) {
      scope.effect(() => scope.imageCapabilities.register(capability()))
    },
  })
  await fiber
  assert.deepEqual(registry.list('provider-a').map(value => value.id), ['image-a'])
  await fiber.dispose()
  assert.deepEqual(registry.list('provider-a'), [])
  assert.deepEqual(registry.listReviews('provider-a'), [])
})

test('registry 注册失败时不会残留 generation capability', () => {
  const registry = new ImageCapabilityRegistryService()
  registry.registerReview(reviewCapability({ id: 'image-a' }))

  assert.throws(
    () => registry.register(capability()),
    error => error instanceof ImageCapabilityError && error.code === 'CAPABILITY_UNAVAILABLE',
  )
  assert.deepEqual(registry.list('provider-a'), [])
  assert.deepEqual(registry.listReviews('provider-a').map(value => value.id), ['image-a'])
})

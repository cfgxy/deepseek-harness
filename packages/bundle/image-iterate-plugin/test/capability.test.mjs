import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageCapabilityError, resolveImageCapability } from '../src/capability.js'

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
  return {
    asked,
    llm: {
      listModels: async provider => {
        assert.equal(provider, 'provider-a')
        return []
      },
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    },
    imageCapabilities: { list: async () => candidates },
    userQuestions: {
      ask: async request => {
        asked.push(request)
        return typeof answer === 'function' ? answer(request) : answer
      },
    },
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

test('当前模型没有 exact capability 时即使只有一个候选也先问询', async () => {
  const ctx = context([capability({ model: 'other-model' })], request => ({
    answers: [{ id: request.questions[0].id, selected: ['image-a'] }],
  }))
  const result = await resolveImageCapability(ctx, agent(), '1024x1024', 'medium')
  assert.equal(result.capability.id, 'image-a')
  assert.equal(ctx.asked.length, 1)
  assert.deepEqual(ctx.asked[0].questions[0].options, [
    { label: 'image-a', description: 'Provider A image capability' },
  ])
})

test('能力未知时先通过问询澄清而不按模型名称猜测', async () => {
  const ctx = context([], request => ({ answers: [{ id: request.questions[0].id, custom: 'unknown-capability', selected: [] }] }))
  await assert.rejects(
    resolveImageCapability(ctx, agent(), '1024x1024', 'medium'),
    error => error instanceof ImageCapabilityError && error.code === 'CAPABILITY_UNAVAILABLE',
  )
  assert.match(ctx.asked[0].questions[0].question, /没有声明可用的图像生成能力/)
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

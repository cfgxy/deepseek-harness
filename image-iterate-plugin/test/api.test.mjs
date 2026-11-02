import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageIterateError, generateAndReview, generateImage } from '../src/api.js'

const IMAGE = Buffer.from('image-bytes').toString('base64')

function config() {
  return {
    maxIterations: 2,
    image: { baseUrl: 'https://image.example/v1', model: 'image-model', token: 'image-token', size: '1024x1024', quality: 'medium', outputFormat: 'png' },
    review: { baseUrl: 'https://review.example/v1', model: 'vision-model', token: 'review-token' },
  }
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function saveImage() {
  let sequence = 0
  return async () => ({ attachmentId: `sha256:${++sequence}`, mediaType: 'image/png', bytes: 11, width: 1, height: 1, name: 'image.png' })
}

test('首次审核通过时只生成一次', async () => {
  const calls = []
  const result = await generateAndReview(config(), { prompt: 'a blue square', acceptanceCriteria: 'must be blue' }, {
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return calls.length === 1
        ? response({ data: [{ b64_json: IMAGE }] })
        : response({ choices: [{ message: { content: '{"accepted":true,"feedback":"符合标准"}' } }] })
    },
    saveImage: saveImage(),
  })
  assert.equal(result.accepted, true)
  assert.equal(result.iteration, 1)
  assert.equal(calls.length, 2)
})

test('审核拒绝后最多再生成一次', async () => {
  const imagePrompts = []
  let call = 0
  const result = await generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'must be blue' }, {
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      call += 1
      if (body.prompt !== undefined) {
        imagePrompts.push(body.prompt)
        return response({ data: [{ b64_json: IMAGE }] })
      }
      return response({ choices: [{ message: { content: call === 2 ? '{"accepted":false,"feedback":"颜色改成蓝色"}' : '{"accepted":true,"feedback":"符合标准"}' } }] })
    },
    saveImage: saveImage(),
  })
  assert.equal(result.accepted, true)
  assert.equal(result.iteration, 2)
  assert.equal(imagePrompts.length, 2)
  assert.match(imagePrompts[1], /颜色改成蓝色/)
})

test('审核 JSON 无效时保留图片并停止重试', async () => {
  let calls = 0
  const result = await generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response({ data: [{ b64_json: IMAGE }] }) : response({ choices: [{ message: { content: 'not json' } }] })
    },
    saveImage: saveImage(),
  })
  assert.equal(result.reviewStatus, 'review_unavailable')
  assert.equal(result.iteration, 1)
  assert.equal(calls, 2)
})

test('缺少 b64_json 时拒绝上游响应', async () => {
  await assert.rejects(() => generateImage(config().image, 'a square', {
    timeoutMs: 100,
    fetchImpl: async () => response({ data: [{}] }),
  }), error => error instanceof ImageIterateError && error.code === 'INVALID_UPSTREAM_RESPONSE')
})

test('上游非 2xx 响应保留拒绝语义', async () => {
  await assert.rejects(() => generateImage(config().image, 'a square', {
    timeoutMs: 100,
    fetchImpl: async () => response({ error: 'denied' }, 401),
  }), error => error instanceof ImageIterateError && error.code === 'UPSTREAM_REJECTED')
})

test('图像请求连接失败时不重试未知结果', async () => {
  let calls = 0
  await assert.rejects(() => generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      throw new TypeError('network error')
    },
    saveImage: saveImage(),
  }), error => error instanceof ImageIterateError && error.code === 'UPSTREAM_OUTCOME_UNKNOWN')
  assert.equal(calls, 1)
})

test('调用方已取消时不发送网络请求', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => generateImage(config().image, 'a square', {
    signal: controller.signal,
    timeoutMs: 100,
    fetchImpl: async () => assert.fail('不应调用 fetch'),
  }), error => error instanceof ImageIterateError && error.code === 'CANCELLED')
})

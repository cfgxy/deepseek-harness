import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMAGE_GENERATION_OUTCOME_UNKNOWN,
  ImageIterateError,
  generateAndReview,
  generateImage,
} from '../src/api.js'

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

test('视觉审核失败不将已生成图片标记为未知结果', async () => {
  let calls = 0
  const result = await generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response({ data: [{ b64_json: IMAGE }] }) : new Response('not json', { status: 200 })
    },
    imageOutcomeUnknown: () => assert.fail('视觉审核不得创建图像未知结果'),
    saveImage: saveImage(),
  })
  assert.equal(result.reviewStatus, 'review_unavailable')
  assert.equal(result.attachment.attachmentId, 'sha256:1')
  assert.equal(calls, 2)
})

test('视觉审核被调用方取消时向上抛出取消错误', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    signal: controller.signal,
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      calls += 1
      if (calls === 1) return response({ data: [{ b64_json: IMAGE }] })
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('review cancelled')), { once: true })
      })
    },
    saveImage: saveImage(),
  })
  while (calls < 2) await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller stopped'))
  await assert.rejects(pending, error => error instanceof ImageIterateError && error.code === 'CANCELLED')
  assert.equal(calls, 2)
})

test('视觉审核 endpoint 配置无效时不降级为审核不可用', async () => {
  const invalid = config()
  invalid.review.baseUrl = 'not an absolute URL'
  await assert.rejects(() => generateAndReview(invalid, { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    timeoutMs: 100,
    fetchImpl: async () => response({ data: [{ b64_json: IMAGE }] }),
    saveImage: saveImage(),
  }), error => error instanceof ImageIterateError && error.code === 'INVALID_CONFIG')
})

test('图像响应缺少 b64_json 时标记为未知结果', async () => {
  let calls = 0
  await assert.rejects(() => generateImage(config().image, 'a square', {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      return response({ data: [{}] })
    },
  }), error => error instanceof ImageIterateError
    && error.code === IMAGE_GENERATION_OUTCOME_UNKNOWN
    && error.cause instanceof ImageIterateError
    && error.cause.code === 'INVALID_UPSTREAM_RESPONSE'
    && /可能已被上游接受并产生计费/.test(error.message)
    && /禁止自动重试/.test(error.message))
  assert.equal(calls, 1)
})

test('图像响应包含非法 b64_json 时标记为未知结果', async () => {
  let calls = 0
  await assert.rejects(() => generateImage(config().image, 'a square', {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      return response({ data: [{ b64_json: 'not-base64' }] })
    },
  }), error => error instanceof ImageIterateError
    && error.code === IMAGE_GENERATION_OUTCOME_UNKNOWN
    && error.cause instanceof ImageIterateError
    && error.cause.code === 'INVALID_UPSTREAM_RESPONSE')
  assert.equal(calls, 1)
})

test('合法 base64 的非图片载荷在附件校验后仍标记为未知结果', async () => {
  const attachmentError = Object.assign(new Error('Unsupported or malformed image data.'), { code: 'INVALID_IMAGE' })
  let calls = 0
  let saves = 0
  await assert.rejects(() => generateAndReview(config(), { prompt: 'a square', acceptanceCriteria: 'blue' }, {
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1
      return response({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })
    },
    saveImage: async () => {
      saves += 1
      throw attachmentError
    },
  }), error => error instanceof ImageIterateError
    && error.code === IMAGE_GENERATION_OUTCOME_UNKNOWN
    && error.cause === attachmentError
    && /禁止自动重试/.test(error.message))
  assert.equal(calls, 1)
  assert.equal(saves, 1)
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
  }), error => error instanceof ImageIterateError
    && error.code === IMAGE_GENERATION_OUTCOME_UNKNOWN
    && error.cause instanceof TypeError)
  assert.equal(calls, 1)
})

for (const [name, fetchImpl] of [
  ['超时', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
  })],
  ['取消', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  })],
  ['非 JSON 响应', async () => new Response('not json', { status: 200 })],
]) {
  test(`图像 POST 已发出后${name}仅调用一次且保留未知结果信息`, async () => {
    const controller = new AbortController()
    let calls = 0
    const pending = generateImage(config().image, 'a square', {
      signal: controller.signal,
      timeoutMs: name === '超时' ? 10 : 1_000,
      fetchImpl: async (...args) => {
        calls += 1
        return fetchImpl(...args)
      },
    })
    if (name === '取消') {
      while (calls === 0) await new Promise(resolve => setImmediate(resolve))
      controller.abort(new Error('caller stopped'))
    }
    await assert.rejects(pending, error => error instanceof ImageIterateError
      && error.code === IMAGE_GENERATION_OUTCOME_UNKNOWN
      && error.cause instanceof Error
      && /可能已被上游接受并产生计费/.test(error.message)
      && /禁止自动重试/.test(error.message))
    assert.equal(calls, 1)
  })
}

test('调用方已取消时不发送网络请求', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => generateImage(config().image, 'a square', {
    signal: controller.signal,
    timeoutMs: 100,
    fetchImpl: async () => assert.fail('不应调用 fetch'),
  }), error => error instanceof ImageIterateError && error.code === 'CANCELLED')
})

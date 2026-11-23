import { Buffer } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { resolveProfiles } from '../src/config.ts'
import { syncImageCapabilities } from '../src/image-capability.ts'

type Generation = {
  id: string
  provider: string
  model: string
  label: string
  sizes?: readonly string[]
  qualities?: readonly string[]
  generate(request: {
    prompt: string
    size: string
    quality: string
    outputFormat: 'png' | 'webp' | 'jpeg'
    signal?: AbortSignal
  }): Promise<{ bytes: Buffer; mimeType: string }>
}

type Review = {
  id: string
  provider: string
  model: string
  label: string
  review(request: {
    image: { bytes: Buffer; mimeType: string }
    acceptanceCriteria: string
    signal?: AbortSignal
  }): Promise<{ accepted: boolean; feedback: string }>
}

class Registry {
  readonly generations: Generation[] = []
  readonly reviews: Review[] = []
  failGenerationModel?: string

  register(capability: Generation): () => void {
    if (capability.model === this.failGenerationModel) throw new Error('fixture registration conflict')
    this.generations.push(capability)
    return () => {
      const index = this.generations.indexOf(capability)
      if (index >= 0) this.generations.splice(index, 1)
    }
  }

  registerReview(capability: Review): () => void {
    this.reviews.push(capability)
    return () => {
      const index = this.reviews.indexOf(capability)
      if (index >= 0) this.reviews.splice(index, 1)
    }
  }
}

function profileWithImage(baseURL = 'https://gateway.test/v1') {
  return resolveProfiles({
    gateway: {
      api: 'openai-completions',
      baseURL,
      apiKeyEnv: 'IMAGE_TEST_KEY',
      headers: { 'X-Tenant': 'tenant-a' },
      models: [
        { id: 'vision-current', input: ['text', 'image'] },
        { id: 'text-only', input: ['text'] },
        { id: 'gpt-image-2' },
      ],
      image: {
        model: 'image-model',
        reviewModel: 'review-fallback',
        sizes: ['1024x1024'],
        qualities: ['medium'],
      },
    },
  })
}

function profileWithoutImage() {
  return resolveProfiles({
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://gateway.test/v1',
      models: [{ id: 'text-only', input: ['text'] }],
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('registers provider-owned generation and review routes and reuses request headers', async () => {
  const ctx = new Context()
  const registry = new Registry()
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    headers.set('X-Waterfall', `${request.purpose}:${request.model}`)
    return next()
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const rawBody = init?.body
    if (typeof rawBody !== 'string') throw new TypeError('fixture request body must be JSON text')
    const body = JSON.parse(rawBody) as Record<string, unknown>
    requests.push({ url, init: init ?? {}, body })
    if (url.endsWith('/images/generations')) {
      return Response.json({ data: [{ b64_json: Buffer.from('generated-image').toString('base64') }] })
    }
    return Response.json({
      choices: [{ message: { content: '{"accepted":true,"feedback":"符合标准"}' } }],
    })
  }))

  const dispose = syncImageCapabilities(
    Object.assign(ctx, { imageCapabilities: registry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )

  expect(registry.generations.map(route => route.model)).toEqual(['image-model'])
  expect(registry.reviews.map(route => route.model).sort()).toEqual(['review-fallback', 'vision-current'])

  const generated = await registry.generations[0]!.generate({
    prompt: 'a blue square',
    size: '1024x1024',
    quality: 'medium',
    outputFormat: 'png',
  })
  const reviewed = await registry.reviews.find(route => route.model === 'vision-current')!.review({
    image: generated,
    acceptanceCriteria: '必须是蓝色方块',
  })

  expect(generated.bytes).toEqual(Buffer.from('generated-image'))
  expect(generated.mimeType).toBe('image/png')
  expect(reviewed).toEqual({ accepted: true, feedback: '符合标准' })
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({
    url: 'https://gateway.test/v1/images/generations',
    body: {
      model: 'image-model',
      prompt: 'a blue square',
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    },
  })
  expect(requests[1]).toMatchObject({
    url: 'https://gateway.test/v1/chat/completions',
    body: {
      model: 'vision-current',
      temperature: 0,
      response_format: { type: 'json_object' },
    },
  })
  expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer fixture-key')
  expect(new Headers(requests[0]!.init.headers).get('x-tenant')).toBe('tenant-a')
  expect(new Headers(requests[0]!.init.headers).get('x-waterfall')).toBe('image-generation:image-model')
  expect(new Headers(requests[1]!.init.headers).get('x-waterfall')).toBe('image-review:vision-current')

  dispose()
  expect(registry.generations).toEqual([])
  expect(registry.reviews).toEqual([])
})

it('does not register an image route when the provider profile does not declare one', () => {
  const registry = new Registry()
  const dispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => profileWithoutImage(),
    async () => 'fixture-key',
  )

  expect(registry.generations).toEqual([])
  expect(registry.reviews).toEqual([])
  dispose()
})

it('fails closed for missing credentials and malformed upstream responses', async () => {
  const registry = new Registry()
  const missingCredentialDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => profileWithImage(),
    async () => { throw new LlmError('missing fixture credential', 'MISSING_CREDENTIAL') },
  )
  await expect(registry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png',
  })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  missingCredentialDispose()

  const invalidRegistry = new Registry()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ b64_json: 'not base64 %' }] })))
  const invalidResponseDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: invalidRegistry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  await expect(invalidRegistry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png',
  })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' })
  invalidResponseDispose()
})

it('replaces old provider routes when the resolved profile is synchronized again', () => {
  const registry = new Registry()
  let current = profileWithImage('https://first.test/v1')
  const firstDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => current,
    async () => 'fixture-key',
  )
  expect(registry.generations.map(route => route.model)).toEqual(['image-model'])
  firstDispose()
  current = resolveProfiles({
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://second.test/v1',
      apiKeyEnv: 'IMAGE_TEST_KEY',
      models: [{ id: 'vision-next', input: ['text', 'image'] }],
      image: { model: 'image-model-next' },
    },
  })
  const secondDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => current,
    async () => 'fixture-key',
  )
  expect(registry.generations.map(route => route.model)).toEqual(['image-model-next'])
  expect(registry.reviews.map(route => route.model)).toEqual(['vision-next'])
  secondDispose()
  expect(registry.generations).toEqual([])
  expect(registry.reviews).toEqual([])
})

it('cleans request resources when a request-header listener rejects the dispatch', async () => {
  const ctx = new Context()
  const registry = new Registry()
  ctx.on('llm-pi-ai/request-headers', () => { throw new Error('fixture header failure') })
  const dispose = syncImageCapabilities(
    Object.assign(ctx, { imageCapabilities: registry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  const controller = new AbortController()
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout')

  await expect(registry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png', signal: controller.signal,
  })).rejects.toThrow('fixture header failure')
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(clearTimer).toHaveBeenCalled()
  dispose()
})

it('restores the previous provider routes when a volatile replacement cannot register', () => {
  const registry = new Registry()
  let current = profileWithImage()
  const sync = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => current,
    async () => 'fixture-key',
  )
  const originalGeneration = registry.generations[0]
  const originalReviews = [...registry.reviews]
  current = resolveProfiles({
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://gateway.test/v1',
      apiKeyEnv: 'IMAGE_TEST_KEY',
      models: [{ id: 'vision-next', input: ['text', 'image'] }],
      image: { model: 'replacement-image-model' },
    },
  })
  registry.failGenerationModel = 'replacement-image-model'

  expect(() => { sync.sync() }).toThrow('fixture registration conflict')
  expect(registry.generations).toEqual([originalGeneration])
  expect(registry.reviews).toEqual(originalReviews)
  sync()
})

it('reports malformed review JSON, non-JSON responses, unknown network outcomes, and cancellation', async () => {
  const registry = new Registry()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    choices: [{ message: { content: 'not-json' } }],
  })))
  const dispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: registry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  const review = registry.reviews.find(route => route.model === 'vision-current')!
  await expect(review.review({
    image: { bytes: Buffer.from('image'), mimeType: 'image/png' },
    acceptanceCriteria: 'criterion',
  })).rejects.toMatchObject({ code: 'INVALID_REVIEW_RESPONSE' })
  dispose()

  const nonJsonRegistry = new Registry()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  })))
  const nonJsonDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: nonJsonRegistry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  await expect(nonJsonRegistry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png',
  })).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' })
  nonJsonDispose()

  const networkRegistry = new Registry()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network fixture failure') }))
  const networkDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: networkRegistry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  await expect(networkRegistry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png',
  })).rejects.toMatchObject({ code: 'UPSTREAM_OUTCOME_UNKNOWN' })
  networkDispose()

  const cancelledRegistry = new Registry()
  const cancelledFetch = vi.fn()
  vi.stubGlobal('fetch', cancelledFetch)
  const cancelledDispose = syncImageCapabilities(
    Object.assign(new Context(), { imageCapabilities: cancelledRegistry }),
    () => profileWithImage(),
    async () => 'fixture-key',
  )
  const controller = new AbortController()
  controller.abort('cancelled before dispatch')
  await expect(cancelledRegistry.generations[0]!.generate({
    prompt: 'prompt', size: '1024x1024', quality: 'medium', outputFormat: 'png', signal: controller.signal,
  })).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(cancelledFetch).not.toHaveBeenCalled()
  cancelledDispose()
})

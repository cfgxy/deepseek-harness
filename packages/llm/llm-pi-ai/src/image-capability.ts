import { Buffer } from 'node:buffer'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { PiAiImageProfile, ResolvedPiAiProviderProfile } from './config.ts'
import type { PiAiRequestHeaderContext } from './types.ts'

type GeneratedImage = { bytes: Buffer; mimeType: ImageMediaType }
type ReviewResult = { accepted: boolean; feedback: string }

interface ImageCapability {
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
  }): Promise<GeneratedImage>
}

interface ImageReviewCapability {
  id: string
  provider: string
  model: string
  label: string
  preferred?: boolean
  review(request: {
    image: GeneratedImage
    acceptanceCriteria: string
    signal?: AbortSignal
  }): Promise<ReviewResult>
}

interface ImageCapabilityRegistry {
  register(capability: ImageCapability): () => void
  registerReview(capability: ImageReviewCapability): () => void
}

export type ImageCapabilityContext = Context & { imageCapabilities: ImageCapabilityRegistry }

type RequestPurpose = 'image-generation' | 'image-review'

function endpoint(baseURL: string, path: string): string {
  try {
    return new URL(path, `${baseURL.replace(/\/+$/, '')}/`).toString()
  } catch {
    throw new LlmError('llm-pi-ai image capability requires a valid absolute baseURL', 'INVALID_CONFIG')
  }
}

function requestHeaders(
  ctx: Context,
  profile: ResolvedPiAiProviderProfile,
  provider: string,
  model: string,
  purpose: RequestPurpose,
): Headers {
  const initial = new Headers(profile.headers)
  const request: PiAiRequestHeaderContext = Object.freeze({
    provider,
    model,
    baseURL: profile.baseURL ?? '',
    purpose,
  })
  return ctx.waterfall('llm-pi-ai/request-headers', request, initial, () => initial)
}

function mediaType(format: 'png' | 'webp' | 'jpeg'): ImageMediaType {
  return `image/${format}`
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function decodeImage(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new LlmError('llm-pi-ai image capability received no valid b64_json image', 'INVALID_UPSTREAM_RESPONSE')
  }
  return Buffer.from(value, 'base64')
}

async function postJson(
  ctx: Context,
  profile: ResolvedPiAiProviderProfile,
  provider: string,
  model: string,
  purpose: RequestPurpose,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>,
): Promise<unknown> {
  const token = await resolveApiKey(provider, profile)
  if (signal?.aborted) {
    throw new LlmError('llm-pi-ai image capability request was cancelled', 'CANCELLED')
  }
  const controller = new AbortController()
  const abort = () => { controller.abort(signal?.reason) }
  if (signal?.aborted) {
    controller.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', abort, { once: true })
  }
  const timeout = setTimeout(() => { controller.abort() }, profile.timeoutMs ?? 120_000)
  let prepared = false
  try {
    const headers = requestHeaders(ctx, profile, provider, model, purpose)
    prepared = true
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
    headers.set('content-type', 'application/json')
    const response = await fetch(endpoint(profile.baseURL ?? '', path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new LlmError(`llm-pi-ai image capability upstream rejected the request (HTTP ${response.status})`, 'UPSTREAM_REJECTED')
    }
    try {
      return await response.json()
    } catch (error) {
      throw new LlmError('llm-pi-ai image capability received a non-JSON response', 'INVALID_UPSTREAM_RESPONSE', { cause: error })
    }
  } catch (error) {
    if (!prepared) throw error
    if (error instanceof LlmError) throw error
    if (signal?.aborted) throw new LlmError('llm-pi-ai image capability request was cancelled', 'CANCELLED', { cause: error })
    throw new LlmError('llm-pi-ai image capability request outcome is unknown; automatic retry is disabled', 'UPSTREAM_OUTCOME_UNKNOWN', { cause: error })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

function imageBaseURL(profile: ResolvedPiAiProviderProfile): string | undefined {
  if (profile.baseURL !== undefined) return profile.baseURL
  return profile.piProvider?.baseUrl
}

// Exact IDs for the Images API contract used by this adapter, in default order.
const OPENAI_IMAGES_MODEL_IDS = [
  'gpt-image-2',
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const

function isKnownImageModel(model: string): boolean {
  return OPENAI_IMAGES_MODEL_IDS.some(id => id === model)
}

function generationCapability(
  ctx: Context,
  provider: string,
  profile: ResolvedPiAiProviderProfile,
  image: PiAiImageProfile,
  baseURL: string,
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>,
): ImageCapability {
  return {
    id: `llm-pi-ai:image:${provider}:${image.model}`,
    provider,
    model: image.model,
    label: `${profile.displayName} image generation`,
    ...image.sizes === undefined ? {} : { sizes: [...image.sizes] },
    ...image.qualities === undefined ? {} : { qualities: [...image.qualities] },
    generate: async (request) => {
      const payload = await postJson(ctx, { ...profile, baseURL }, provider, image.model, 'image-generation', 'images/generations', {
        model: image.model,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        quality: request.quality,
        output_format: request.outputFormat,
      }, request.signal, resolveApiKey)
      const data = parseObject(payload)?.data
      const first = Array.isArray(data) ? parseObject(data[0]) : undefined
      return { bytes: decodeImage(first?.b64_json), mimeType: mediaType(request.outputFormat) }
    },
  }
}

function reviewCapability(
  ctx: Context,
  provider: string,
  profile: ResolvedPiAiProviderProfile,
  model: string,
  baseURL: string,
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>,
  preferred: boolean,
): ImageReviewCapability {
  return {
    id: `llm-pi-ai:review:${provider}:${model}`,
    provider,
    model,
    label: `${profile.displayName} visual review`,
    ...preferred ? { preferred: true } : {},
    review: async (request) => {
      const payload = await postJson(ctx, { ...profile, baseURL }, provider, model, 'image-review', 'chat/completions', {
        model,
        ...profile.image === undefined ? {} : { temperature: 0 },
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '检查图片是否满足验收标准。仅返回 JSON：{"accepted":boolean,"feedback":string}。accepted 为 false 时 feedback 给出可执行修改意见。',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `验收标准：${request.acceptanceCriteria}` },
              { type: 'image_url', image_url: { url: `data:${request.image.mimeType};base64,${request.image.bytes.toString('base64')}` } },
            ],
          },
        ],
      }, request.signal, resolveApiKey)
      const choices = parseObject(payload)?.choices
      const first = Array.isArray(choices) ? parseObject(choices[0]) : undefined
      const message = parseObject(first?.message)
      const content = typeof message?.content === 'string' ? message.content.trim() : ''
      try {
        const result = parseObject(JSON.parse(content))
        if (typeof result?.accepted !== 'boolean' || typeof result.feedback !== 'string') throw new TypeError('invalid review')
        return { accepted: result.accepted, feedback: result.feedback.trim() }
      } catch (error) {
        throw new LlmError('llm-pi-ai image capability received invalid review JSON', 'INVALID_REVIEW_RESPONSE', { cause: error })
      }
    },
  }
}

type CapabilityRegistration = () => () => void
export type ImageCapabilitySynchronizer = (() => void) & { sync(): void }

function disposeCapabilities(disposers: readonly (() => void)[]): void {
  for (const dispose of [...disposers].reverse()) dispose()
}

function installCapabilities(registrations: readonly CapabilityRegistration[]): (() => void)[] {
  const disposers: (() => void)[] = []
  try {
    for (const register of registrations) disposers.push(register())
    return disposers
  } catch (error) {
    disposeCapabilities(disposers)
    throw error
  }
}

function imageCapabilityRegistrations(
  ctx: ImageCapabilityContext,
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>,
): CapabilityRegistration[] {
  const registrations: CapabilityRegistration[] = []
  for (const [provider, profile] of profiles) {
    const baseURL = imageBaseURL(profile)
    if (baseURL === undefined) continue
    const models = profile.piProvider?.getModels() ?? []
    const configuredImage = profile.image
    const discoveredImage = configuredImage === undefined
      ? OPENAI_IMAGES_MODEL_IDS.find(id => models.some(model => model.id === id && model.api === 'openai-completions'))
      : undefined
    const image = configuredImage ?? (discoveredImage === undefined ? undefined : { model: discoveredImage })
    if (image !== undefined) {
      const generation = generationCapability(ctx, provider, profile, image, baseURL, resolveApiKey)
      registrations.push(() => ctx.imageCapabilities.register(generation))
    }
    const explicitReview = configuredImage?.reviewModel
    if (explicitReview !== undefined) {
      const review = reviewCapability(ctx, provider, profile, explicitReview, baseURL, resolveApiKey, true)
      registrations.push(() => ctx.imageCapabilities.registerReview(review))
    }
    for (const model of models) {
      if (model.id === explicitReview || isKnownImageModel(model.id) || !model.input.includes('image')) continue
      if (configuredImage === undefined && (model.api !== 'openai-completions' || !model.input.includes('text'))) continue
      const review = reviewCapability(ctx, provider, profile, model.id, baseURL, resolveApiKey, false)
      registrations.push(() => ctx.imageCapabilities.registerReview(review))
    }
  }
  return registrations
}

/** Synchronize provider-owned image routes with the current resolved profile snapshot. */
export function syncImageCapabilities(
  ctx: ImageCapabilityContext,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>,
): ImageCapabilitySynchronizer {
  let registrations: CapabilityRegistration[] = []
  let disposers: (() => void)[] = []
  const synchronize = (): void => {
    const nextRegistrations = imageCapabilityRegistrations(ctx, profiles(), resolveApiKey)
    const previousRegistrations = registrations
    const previousDisposers = disposers
    disposeCapabilities(previousDisposers)
    registrations = []
    disposers = []
    try {
      disposers = installCapabilities(nextRegistrations)
      registrations = nextRegistrations
    } catch (error) {
      // A bad volatile update must not withdraw the last working provider routes.
      disposers = installCapabilities(previousRegistrations)
      registrations = previousRegistrations
      throw error
    }
  }
  const dispose = (() => {
    disposeCapabilities(disposers)
    disposers = []
    registrations = []
  }) as ImageCapabilitySynchronizer
  dispose.sync = synchronize
  synchronize()
  return dispose
}

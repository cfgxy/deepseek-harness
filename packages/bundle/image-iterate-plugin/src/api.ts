import { Buffer } from 'node:buffer'
import type { ImageMediaType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Error codes emitted by the image generation and review operation. */
export type ImageIterateErrorCode =
  | 'CANCELLED'
  | 'INVALID_CONFIG'
  | 'INVALID_REVIEW_RESPONSE'
  | 'INVALID_UPSTREAM_RESPONSE'
  | 'IMAGE_GENERATION_OUTCOME_UNKNOWN'
  | 'IMAGE_ITERATE_FAILED'
  | 'MISSING_CONFIG'
  | 'MISSING_CREDENTIAL'
  | 'UPSTREAM_OUTCOME_UNKNOWN'
  | 'UPSTREAM_REJECTED'
  | 'UPSTREAM_UNREACHABLE'

/** Typed failure from the image provider or review provider. */
export class ImageIterateError extends Error {
  readonly code: ImageIterateErrorCode

  constructor(code: ImageIterateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageIterateError'
    this.code = code
  }
}

/** Stable code for an image request whose billing outcome cannot be determined. */
export const IMAGE_GENERATION_OUTCOME_UNKNOWN = 'IMAGE_GENERATION_OUTCOME_UNKNOWN'

/** User-facing explanation for an indeterminate image request. */
export const IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE = '图像生成请求可能已被上游接受并产生计费，但结果无法确认。禁止自动重试；请先在上游控制台或账单记录中核对结果。'

/** Image request settings resolved by the Host plugin. */
export interface ImageGenerationConfig {
  baseUrl: string
  model: string
  token: string
  size: string
  quality: string
  outputFormat: 'png' | 'webp' | 'jpeg'
}

/** Provider-owned image generation closure; endpoint and credential stay with the provider. */
export interface ImageGenerationCapability {
  generate(prompt: string, signal?: AbortSignal): Promise<GeneratedImage>
}

/** Visual review request settings resolved by the Host plugin. */
export interface ReviewConfig {
  baseUrl: string
  model: string
  token: string
}

/** Provider-owned visual review closure; endpoint and credential stay with the provider. */
export interface ReviewCapability {
  review(image: GeneratedImage, acceptanceCriteria: string, signal?: AbortSignal): Promise<ReviewResult>
}

/** One generated image before durable attachment storage. */
export interface GeneratedImage {
  bytes: Buffer
  mimeType: ImageMediaType
}

/** Durable image reference returned by the caller-owned attachment store. */
export type SavedImageReference = ImageAttachmentRef

/** Input for one bounded generation and review operation. */
export interface GenerateAndReviewRequest {
  prompt: string
  acceptanceCriteria: string
}

/** Review result returned by the configured vision model. */
export interface ReviewResult {
  accepted: boolean
  feedback: string
}

/** Options owned by the operation caller. */
export interface ImageIterateOptions {
  signal?: AbortSignal
  timeoutMs: number
  fetchImpl: typeof fetch
  imageOutcomeUnknown?: (cause: unknown) => Error
  saveImage: (image: GeneratedImage, iteration: number) => Promise<SavedImageReference>
}

/** Completed result including the last durable image reference. */
export interface GenerateAndReviewResult {
  attachment: SavedImageReference
  iteration: number
  accepted: boolean
  reviewStatus: 'accepted' | 'review_unavailable' | 'rejected_at_limit'
  feedback: string
}

type JsonObject = Record<string, unknown>

type RequestOptions = Pick<ImageIterateOptions, 'signal' | 'timeoutMs' | 'fetchImpl'> & {
  imageOutcomeUnknown?: (cause: unknown) => Error
}

function record(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? value as JsonObject : undefined
}

function imageOutcomeUnknown(options: RequestOptions, cause: unknown): Error {
  if (options.imageOutcomeUnknown !== undefined) return options.imageOutcomeUnknown(cause)
  return new ImageIterateError(IMAGE_GENERATION_OUTCOME_UNKNOWN, IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE, { cause })
}

function endpoint(baseUrl: string, path: string): string {
  try {
    return new URL(path, `${baseUrl.replace(/\/+$/, '')}/`).toString()
  } catch {
    throw new ImageIterateError('INVALID_CONFIG', '上游 endpoint 必须是合法的绝对 URL。')
  }
}

async function requestJson(
  url: string,
  token: string,
  body: JsonObject,
  options: RequestOptions,
): Promise<unknown> {
  if (options.signal?.aborted) throw new ImageIterateError('CANCELLED', '图像任务已取消，未发起上游请求。')

  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let submitted = false

  try {
    submitted = true
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new ImageIterateError('UPSTREAM_REJECTED', `上游请求被拒绝（HTTP ${response.status}）。请检查 endpoint、模型和凭据权限。`)
    }
    try {
      return await response.json()
    } catch (error) {
      if (options.imageOutcomeUnknown !== undefined) throw imageOutcomeUnknown(options, error)
      throw new ImageIterateError('INVALID_UPSTREAM_RESPONSE', '上游返回了非 JSON 响应。', { cause: error })
    }
  } catch (error) {
    if (error instanceof ImageIterateError) throw error
    if (record(error)?.code === IMAGE_GENERATION_OUTCOME_UNKNOWN) throw error
    if (submitted) {
      if (options.imageOutcomeUnknown !== undefined) throw imageOutcomeUnknown(options, error)
      if (options.signal?.aborted) throw new ImageIterateError('CANCELLED', '图像任务已取消。', { cause: error })
      const reason = controller.signal.aborted
        ? `视觉审核请求在 ${options.timeoutMs}ms 内未完成`
        : '无法连接视觉审核上游'
      throw new ImageIterateError('UPSTREAM_OUTCOME_UNKNOWN', `${reason}。无法确认上游是否已接受请求，因此不会自动重试。`, { cause: error })
    }
    throw new ImageIterateError('UPSTREAM_UNREACHABLE', '无法连接图像或视觉审核上游。', { cause: error })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

function decodeImage(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ImageIterateError('INVALID_UPSTREAM_RESPONSE', '上游未返回有效的 b64_json 图像内容。')
  }
  return Buffer.from(value, 'base64')
}

function parseReview(value: unknown): ReviewResult {
  const content = typeof value === 'string' ? value.trim().replace(/^```(?:json)?\s*|\s*```$/g, '') : ''
  try {
    const parsed = JSON.parse(content)
    const object = record(parsed)
    if (typeof object?.accepted !== 'boolean' || typeof object.feedback !== 'string') throw new TypeError('bad review')
    return { accepted: object.accepted, feedback: object.feedback.trim() }
  } catch {
    throw new ImageIterateError('INVALID_REVIEW_RESPONSE', '视觉审核未返回 {"accepted": boolean, "feedback": string} JSON。')
  }
}

/** Submit one image generation request and decode its base64 result. */
export async function generateImage(
  config: ImageGenerationConfig,
  prompt: string,
  options: ImageIterateOptions,
): Promise<GeneratedImage> {
  try {
    const payload = await requestJson(endpoint(config.baseUrl, 'images/generations'), config.token, {
      model: config.model,
      prompt,
      n: 1,
      size: config.size,
      quality: config.quality,
      output_format: config.outputFormat,
    }, {
      ...options,
      imageOutcomeUnknown: cause => imageOutcomeUnknown(options, cause),
    })
    const data = record(payload)?.data
    const first = Array.isArray(data) ? record(data[0]) : undefined
    return { bytes: decodeImage(first?.b64_json), mimeType: `image/${config.outputFormat}` as ImageMediaType }
  } catch (error) {
    if (error instanceof ImageIterateError
      && ['CANCELLED', 'INVALID_CONFIG', 'IMAGE_GENERATION_OUTCOME_UNKNOWN', 'UPSTREAM_REJECTED'].includes(error.code)) {
      throw error
    }
    throw imageOutcomeUnknown(options, error)
  }
}

/** Submit one visual review request for a generated image. */
export async function reviewImage(
  config: ReviewConfig,
  image: GeneratedImage,
  acceptanceCriteria: string,
  options: ImageIterateOptions,
): Promise<ReviewResult> {
  const payload = await requestJson(endpoint(config.baseUrl, 'chat/completions'), config.token, {
    model: config.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '检查图片是否满足验收标准。仅返回 JSON：{"accepted":boolean,"feedback":string}。accepted 为 false 时 feedback 给出可执行修改意见。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `验收标准：${acceptanceCriteria}` },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` } },
        ],
      },
    ],
  }, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const choices = record(payload)?.choices
  const first = Array.isArray(choices) ? record(choices[0]) : undefined
  const message = record(first?.message)
  return parseReview(message?.content)
}

function revisionPrompt(prompt: string, feedback: string): string {
  return `${prompt}\n\n请根据以下审核反馈修改：${feedback}`
}

function isReviewUnavailable(error: ImageIterateError): boolean {
  return error.code === 'INVALID_REVIEW_RESPONSE'
    || error.code === 'INVALID_UPSTREAM_RESPONSE'
    || error.code === 'UPSTREAM_OUTCOME_UNKNOWN'
    || error.code === 'UPSTREAM_REJECTED'
    || error.code === 'UPSTREAM_UNREACHABLE'
}

/** Generate, persist, review, and revise within the configured paid-request limit. */
export async function generateAndReview(
  config: {
    maxIterations: number
    image: ImageGenerationConfig | ImageGenerationCapability
    review: ReviewConfig | ReviewCapability
  },
  request: GenerateAndReviewRequest,
  options: ImageIterateOptions,
): Promise<GenerateAndReviewResult> {
  const generate = (prompt: string): Promise<GeneratedImage> =>
    'generate' in config.image
      ? config.image.generate(prompt, options.signal)
      : generateImage(config.image, prompt, options)
  const reviewCandidate = (image: GeneratedImage): Promise<ReviewResult> =>
    'review' in config.review
      ? config.review.review(image, request.acceptanceCriteria, options.signal)
      : reviewImage(config.review, image, request.acceptanceCriteria, options)
  const persist = async (image: GeneratedImage, iteration: number): Promise<SavedImageReference> => {
    if (options.signal?.aborted) {
      throw new ImageIterateError('CANCELLED', '图像任务已取消，未持久化最终结果。', { cause: options.signal.reason })
    }
    try {
      return await options.saveImage(image, iteration)
    } catch (error) {
      if (record(error)?.code === IMAGE_GENERATION_OUTCOME_UNKNOWN) throw error
      throw imageOutcomeUnknown(options, error)
    }
  }

  let prompt = request.prompt
  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const image = await generate(prompt)
    let review: ReviewResult
    try {
      review = await reviewCandidate(image)
    } catch (error) {
      if (error instanceof ImageIterateError && isReviewUnavailable(error)) {
        const attachment = await persist(image, iteration)
        return { attachment, iteration, accepted: false, reviewStatus: 'review_unavailable', feedback: error.message }
      }
      throw error
    }
    if (review.accepted) {
      const attachment = await persist(image, iteration)
      return { attachment, iteration, accepted: true, reviewStatus: 'accepted', feedback: review.feedback }
    }
    if (iteration === config.maxIterations) {
      const attachment = await persist(image, iteration)
      return { attachment, iteration, accepted: false, reviewStatus: 'rejected_at_limit', feedback: review.feedback }
    }
    prompt = revisionPrompt(request.prompt, review.feedback)
  }
  throw new ImageIterateError('INVALID_CONFIG', 'maxIterations 必须为正整数。')
}

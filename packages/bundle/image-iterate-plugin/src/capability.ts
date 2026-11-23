import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { GeneratedImage, ReviewResult } from './api.ts'

/** Provider-owned image operations. Credentials and endpoints stay inside these closures. */
export interface ImageCapability {
  /** Stable provider-owned capability id used only for user selection. */
  id: string
  /** Provider route owning the endpoint and credential. */
  provider: string
  /** Exact model route served by the capability. */
  model: string
  /** User-facing label that contains no secret material. */
  label: string
  /** Advertised image sizes; absence means the capability does not disclose them. */
  sizes?: readonly string[]
  /** Advertised image qualities; absence means the capability does not disclose them. */
  qualities?: readonly string[]
  /** Provider-owned generation closure. */
  generate(request: {
    prompt: string
    size: string
    quality: string
    outputFormat: 'png' | 'webp' | 'jpeg'
    signal?: AbortSignal
  }): Promise<GeneratedImage>
  /** Provider-owned visual review closure when this generation route also reviews images. */
  review?: (request: {
    image: GeneratedImage
    acceptanceCriteria: string
    signal?: AbortSignal
  }) => Promise<ReviewResult>
}

/** A provider-owned visual review route that may be separate from image generation. */
export interface ImageReviewCapability {
  /** Stable provider-owned capability id used only for user selection. */
  id: string
  /** Provider route owning the endpoint and credential. */
  provider: string
  /** Exact model route served by the capability. */
  model: string
  /** User-facing label that contains no secret material. */
  label: string
  /** Explicit provider review default when the current model has no review route. */
  preferred?: boolean
  /** Provider-owned visual review closure. */
  review(request: {
    image: GeneratedImage
    acceptanceCriteria: string
    signal?: AbortSignal
  }): Promise<ReviewResult>
}

/** Provider-owned registry with effect-friendly registration and teardown. */
export interface ImageCapabilityRegistry {
  /** Register one generation route and return its disposer. */
  register(capability: ImageCapability): () => void
  /** Register one independent visual review route and return its disposer. */
  registerReview(capability: ImageReviewCapability): () => void
  /** List generation routes owned by one provider. */
  list(provider: string): readonly ImageCapability[] | Promise<readonly ImageCapability[]>
  /** List visual review routes owned by one provider. */
  listReviews(provider: string): readonly ImageReviewCapability[] | Promise<readonly ImageReviewCapability[]>
}

/** In-memory registry used by the built-in service and provider composition tests. */
export class ImageCapabilityRegistryService implements ImageCapabilityRegistry {
  private readonly generation = new Map<string, ImageCapability>()
  private readonly review = new Map<string, ImageReviewCapability>()

  register(capability: ImageCapability): () => void {
    this.assertUnique(this.generation, capability)
    const review = capability.review === undefined ? undefined : {
      id: capability.id,
      provider: capability.provider,
      model: capability.model,
      label: capability.label,
      review: capability.review,
    }
    if (review !== undefined) this.assertUnique(this.review, review)
    this.generation.set(capability.id, capability)
    if (review !== undefined) this.review.set(review.id, review)
    return () => {
      if (this.generation.get(capability.id) !== capability) return
      this.generation.delete(capability.id)
      if (review !== undefined && this.review.get(review.id) === review) this.review.delete(review.id)
    }
  }

  registerReview(capability: ImageReviewCapability): () => void {
    this.assertUnique(this.review, capability)
    this.review.set(capability.id, capability)
    return () => {
      if (this.review.get(capability.id) === capability) this.review.delete(capability.id)
    }
  }

  list(provider: string): readonly ImageCapability[] {
    return [...this.generation.values()].filter(capability => capability.provider === provider)
  }

  listReviews(provider: string): readonly ImageReviewCapability[] {
    return [...this.review.values()].filter(capability => capability.provider === provider)
  }

  private assertUnique<T extends { id: string; provider: string; model: string }>(map: Map<string, T>, capability: T): void {
    if (capability.id.trim() === '' || capability.provider.trim() === '' || capability.model.trim() === '') {
      throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '图像 capability 的 id、provider 和 model 不能为空。')
    }
    const existing = map.get(capability.id)
    if (existing !== undefined && existing !== capability) {
      throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', `图像 capability id「${capability.id}」已注册。`)
    }
  }
}

/** Ensure the formal registry service exists in the current Cordis scope.
 * @param ctx - Cordis context that owns the registry service.
 * @returns The existing or newly provided image capability registry.
 */
export function provideImageCapabilityRegistry(ctx: Context): ImageCapabilityRegistry {
  const existing = ctx.get('imageCapabilities')
  if (existing !== undefined) return existing
  const registry = new ImageCapabilityRegistryService()
  ctx.provide('imageCapabilities', registry)
  return registry
}

interface UserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

interface UserQuestionService {
  ask(request: {
    agent: Agent
    signal?: AbortSignal
    questions: Array<{
      id: string
      header?: string
      question: string
      detail?: string
      options?: Array<{ label: string; description?: string }>
    }>
  }): Promise<UserQuestionAnswer>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider-owned image capability registry supplied by the image plugin. */
    imageCapabilities: ImageCapabilityRegistry
    /** User-question service supplied by the Host composition. */
    userQuestions: UserQuestionService
  }
}

export interface ImageCapabilityResolution {
  capability: ImageCapability
  review: ImageReviewCapability
  size: string
  quality: string
}

export type ImageCapabilitySelectionFailure =
  | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_SELECTION_REQUIRED'
  | 'CAPABILITY_SELECTION_CANCELLED'
  | 'CAPABILITY_SELECTION_UNAVAILABLE'

export class ImageCapabilityError extends Error {
  readonly code: ImageCapabilitySelectionFailure

  constructor(code: ImageCapabilitySelectionFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageCapabilityError'
    this.code = code
  }
}

type QuestionContext = Pick<Context, 'userQuestions'>
type QuestionOption = { label: string; description?: string }

type SelectionRequest = {
  id: string
  header: string
  question: string
  detail: string
  options?: QuestionOption[]
}

/** Format a model label for capability-selection questions.
 * @param info - Model metadata returned by the provider directory.
 * @returns The display name with the stable model id when they differ.
 */
function modelLabel(info: LlmModelInfo): string {
  return info.name === info.id ? info.id : `${info.name} (${info.id})`
}

function answerSelection(answer: UserQuestionAnswer, id: string): string | undefined {
  const item = answer.answers.find(entry => entry.id === id)
  const selected = item?.selected[0]
  if (selected !== undefined && selected.trim() !== '') return selected.trim()
  const custom = item?.custom?.trim()
  return custom === '' ? undefined : custom
}

async function askSelection(
  ctx: QuestionContext,
  agent: Agent,
  signal: AbortSignal | undefined,
  request: SelectionRequest,
): Promise<string> {
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      ...(signal === undefined ? {} : { signal }),
      questions: [{
        id: request.id,
        header: request.header,
        question: request.question,
        detail: request.detail,
        ...(request.options === undefined ? {} : { options: request.options }),
      }],
    })
    const selected = answerSelection(answer, request.id)
    if (selected === undefined) throw new ImageCapabilityError('CAPABILITY_SELECTION_REQUIRED', '未选择图像 capability 或参数。')
    return selected
  } catch (error) {
    if (error instanceof ImageCapabilityError) throw error
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'ASK_ABORTED' || code === 'ASK_CANCELLED') {
      throw new ImageCapabilityError('CAPABILITY_SELECTION_CANCELLED', '图像 capability 问询已取消。', { cause: error })
    }
    if (code === 'NO_PROVIDER') {
      throw new ImageCapabilityError('CAPABILITY_SELECTION_UNAVAILABLE', '当前没有可用的用户问询 answerer，无法确定图像 capability。', { cause: error })
    }
    throw error
  }
}

async function askForCapability(
  ctx: QuestionContext,
  agent: Agent,
  signal: AbortSignal | undefined,
  candidates: readonly ImageCapability[],
): Promise<string> {
  return askSelection(ctx, agent, signal, {
    id: 'image-capability',
    header: '图像能力',
    question: '请选择用于图像生成的模型。',
    detail: '只可选择当前 provider 已注册的生图模型。',
    options: candidates.map(candidate => ({ label: candidate.id, description: candidate.label })),
  })
}

async function resolveControl(
  ctx: QuestionContext,
  agent: Agent,
  signal: AbortSignal | undefined,
  capability: ImageCapability,
  kind: 'size' | 'quality',
  value: string,
): Promise<string> {
  const options = kind === 'size' ? capability.sizes : capability.qualities
  if (value.trim() !== '') {
    if (options !== undefined && !options.includes(value)) {
      throw new ImageCapabilityError('CAPABILITY_SELECTION_REQUIRED', `图像 capability 不支持${kind === 'size' ? '尺寸' : '质量'}「${value}」，需要重新选择。`)
    }
    return value
  }
  return askSelection(ctx, agent, signal, {
    id: `image-${kind}`,
    header: kind === 'size' ? '图像尺寸' : '图像质量',
    question: options === undefined || options.length === 0
      ? `当前 capability 没有声明${kind === 'size' ? '图像尺寸' : '图像质量'}，请提供本次请求使用的值。`
      : `请选择本次请求使用的${kind === 'size' ? '图像尺寸' : '图像质量'}。`,
    detail: '该值只用于当前图像请求，不会读取或记录 provider 的原始凭据。',
    ...(options === undefined || options.length === 0 ? {} : {
      options: options.map(option => ({ label: option })),
    }),
  })
}

function requireRegistry(ctx: Context): ImageCapabilityRegistry {
  const registry = ctx.get('imageCapabilities')
  if (registry === undefined) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '图像 capability registry 尚未提供。')
  }
  return registry
}

async function selectGeneration(
  ctx: Context,
  agent: Agent,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ImageCapability> {
  const candidates = (await requireRegistry(ctx).list(provider)).filter(candidate => candidate.provider === provider)
  const exact = candidates.filter(candidate => candidate.model === model)
  const selectable = exact.length === 0 ? candidates : exact
  if (selectable[0] === undefined) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', `当前 provider「${provider}」没有可用的生图模型。请在模型配置中添加受支持的生图模型，或设置生图覆盖。`)
  }
  if (selectable.length === 1) return selectable[0]
  const selectedId = await askForCapability(ctx, agent, signal, selectable)
  const selected = selectable.find(candidate => candidate.id === selectedId)
  if (selected === undefined) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '所选生图模型不存在或不属于当前 provider。')
  }
  return selected
}

async function selectReview(
  ctx: Context,
  provider: string,
  model: string,
  selected: ImageCapability,
): Promise<ImageReviewCapability> {
  const candidates = (await requireRegistry(ctx).listReviews(provider)).filter(candidate => candidate.provider === provider)
  const inline = selected.review === undefined ? undefined : {
    id: selected.id,
    provider: selected.provider,
    model: selected.model,
    label: selected.label,
    review: selected.review,
  }
  if (inline?.model === model) return inline
  const review = candidates.find(candidate => candidate.model === model)
    ?? candidates.find(candidate => candidate.preferred)
    ?? inline
    ?? candidates[0]
  if (review === undefined) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', `当前 provider「${provider}」没有可用的视觉审核模型。请为视觉模型声明文本和图像输入，或设置视觉审核覆盖。`)
  }
  return review
}

/**
 * Choose generation and review independently. Automatic routes stay on the current provider.
 * @param ctx - Capability and question services.
 * @param agent - Agent whose current model determines the provider and preferred reviewer.
 * @param size - Requested size, or an empty string to ask the user.
 * @param quality - Requested quality, or an empty string to ask the user.
 * @param signal - Cancellation signal for user questions, when supplied.
 * @param options - Optional per-call replacements; each skips resolution of its automatic route.
 * @returns Both routes and validated controls. Rejects before generation if no route is available.
 */
export async function resolveImageCapability(
  ctx: Context,
  agent: Agent,
  size: string,
  quality: string,
  signal?: AbortSignal,
  options: { imageOverride?: ImageCapability; reviewOverride?: ImageReviewCapability } = {},
): Promise<ImageCapabilityResolution> {
  const current = agent.model.current()
  if (current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string'
    || current.provider.trim() === '' || current.model.trim() === '') {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '当前聊天没有可确定的 provider/model 路由。')
  }
  const selected = options.imageOverride ?? await selectGeneration(ctx, agent, current.provider, current.model, signal)
  const review = options.reviewOverride ?? await selectReview(ctx, current.provider, current.model, selected)
  const resolvedSize = await resolveControl(ctx, agent, signal, selected, 'size', size)
  const resolvedQuality = await resolveControl(ctx, agent, signal, selected, 'quality', quality)
  return { capability: selected, review, size: resolvedSize, quality: resolvedQuality }
}

/** Keep the selected capability opaque to the API consumer while adapting its closures. */
export function capabilityConfig(
  capability: ImageCapability,
  review: ImageReviewCapability,
  size: string,
  quality: string,
  outputFormat: 'png' | 'webp' | 'jpeg',
) {
  return {
    image: {
      generate: (prompt: string, signal?: AbortSignal) => capability.generate({
        prompt,
        size,
        quality,
        outputFormat,
        ...(signal === undefined ? {} : { signal }),
      }),
    },
    review: {
      review: (image: GeneratedImage, acceptanceCriteria: string, signal?: AbortSignal) => review.review({
        image,
        acceptanceCriteria,
        ...(signal === undefined ? {} : { signal }),
      }),
    },
  }
}

export { modelLabel }

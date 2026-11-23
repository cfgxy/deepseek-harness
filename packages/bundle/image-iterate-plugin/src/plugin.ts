import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  IMAGE_GENERATION_OUTCOME_UNKNOWN,
  IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE,
  ImageIterateError,
  generateAndReview,
  generateImage,
  reviewImage,
} from './api.ts'
import type { Config } from './index.ts'
import type { GeneratedImage, ImageGenerationConfig, ReviewConfig } from './api.ts'
import { capabilityConfig, ImageCapabilityError, provideImageCapabilityRegistry, resolveImageCapability } from './capability.ts'
import type { ImageCapability, ImageReviewCapability } from './capability.ts'

type OutputFormat = 'png' | 'webp' | 'jpeg'

type ConfigSnapshot = {
  imageBaseUrl: string
  imageModel: string
  imageCredential: string
  reviewBaseUrl: string
  reviewModel: string
  reviewCredential: string
  maxIterations: number
  timeoutMs: number
  defaultSize: string
  defaultQuality: string
  outputFormat: string
}

type ImageToolArgs = {
  prompt: string
  acceptance_criteria: string
  size?: string
  quality?: string
}

type ImageToolResult = {
  image: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number }
  }
  iteration: number
  accepted: boolean
  review_status: string
  feedback: string
}

const imageSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    attachmentId: { type: 'string' as const, required: true as const },
    mediaType: { type: 'string' as const, required: true as const },
    bytes: { type: 'integer' as const, required: true as const },
    width: { type: 'integer' as const, required: true as const },
    height: { type: 'integer' as const, required: true as const },
    name: { type: 'string' as const },
    originalDimensions: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        width: { type: 'integer' as const, required: true as const },
        height: { type: 'integer' as const, required: true as const },
      },
    },
  },
}

const resultSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    image: { ...imageSchema, required: true as const },
    iteration: { type: 'integer' as const, required: true as const },
    accepted: { type: 'boolean' as const, required: true as const },
    review_status: { type: 'string' as const, required: true as const },
    feedback: { type: 'string' as const, required: true as const },
  },
}

function ensureConfig(config: Config): ConfigSnapshot {
  const snapshot: ConfigSnapshot = {
    imageBaseUrl: config.imageBaseUrl.get(),
    imageModel: config.imageModel.get(),
    imageCredential: config.imageCredential.get(),
    reviewBaseUrl: config.reviewBaseUrl.get(),
    reviewModel: config.reviewModel.get(),
    reviewCredential: config.reviewCredential.get(),
    maxIterations: config.maxIterations.get(),
    timeoutMs: config.timeoutMs.get(),
    defaultSize: config.defaultSize.get(),
    defaultQuality: config.defaultQuality.get(),
    outputFormat: config.outputFormat.get(),
  }
  if (!Number.isInteger(snapshot.maxIterations) || snapshot.maxIterations < 1 || snapshot.maxIterations > 3) {
    throw new ImageIterateError('INVALID_CONFIG', 'maxIterations 必须是 1 到 3 的整数。')
  }
  if (!Number.isInteger(snapshot.timeoutMs) || snapshot.timeoutMs < 1000) {
    throw new ImageIterateError('INVALID_CONFIG', 'timeoutMs 必须是不小于 1000 的整数。')
  }
  if (!['png', 'webp', 'jpeg'].includes(snapshot.outputFormat)) {
    throw new ImageIterateError('INVALID_CONFIG', 'outputFormat 仅支持 png、webp 或 jpeg。')
  }
  const imageOverride = [snapshot.imageBaseUrl, snapshot.imageModel, snapshot.imageCredential]
  const reviewOverride = [snapshot.reviewBaseUrl, snapshot.reviewModel, snapshot.reviewCredential]
  for (const [role, values] of [['图像生成', imageOverride], ['视觉审核', reviewOverride]] as const) {
    const configured = values.filter(value => value.trim() !== '').length
    if (configured !== 0 && configured !== values.length) {
      throw new ImageIterateError('INVALID_CONFIG', `${role} override 必须同时配置 endpoint、model 和 credential reference。`)
    }
  }
  return snapshot
}

async function resolveCredential(ctx: Context, reference: string, role: string): Promise<string> {
  if (!isCredentialRefName(reference)) {
    throw new ImageIterateError('INVALID_CONFIG', `${role}凭据引用必须是 POSIX 环境变量名称。`)
  }
  const resolved = await ctx.credentials.resolve(credentialRef(reference))
  if (resolved === undefined || resolved.value.trim() === '') {
    throw new ImageIterateError('MISSING_CREDENTIAL', `${role}凭据 ${reference} 未配置。请通过 DSH 凭据服务或启动环境设置它。`)
  }
  return resolved.value
}

function configuredCapabilities(
  ctx: Context,
  provider: string,
  config: ConfigSnapshot,
  outputFormat: OutputFormat,
): { imageOverride?: ImageCapability; reviewOverride?: ImageReviewCapability } {
  const noPersist = async (_image: GeneratedImage, _iteration: number): Promise<never> => {
    throw new ImageIterateError('IMAGE_ITERATE_FAILED', '单次 provider capability 不应直接持久化图像。')
  }
  const imageConfig = async (size: string, quality: string): Promise<ImageGenerationConfig> => ({
    baseUrl: config.imageBaseUrl,
    model: config.imageModel,
    token: await resolveCredential(ctx, config.imageCredential, '图像生成'),
    size,
    quality,
    outputFormat,
  })
  const reviewConfig = async (): Promise<ReviewConfig> => ({
    baseUrl: config.reviewBaseUrl,
    model: config.reviewModel,
    token: await resolveCredential(ctx, config.reviewCredential, '视觉审核'),
  })
  return {
    ...config.imageBaseUrl.trim() === '' ? {} : { imageOverride: {
      id: `image-iterate-override:${provider}`,
      provider,
      model: config.imageModel,
      label: 'Configured OpenAI-compatible image route',
      generate: async request => generateImage(await imageConfig(request.size, request.quality), request.prompt, {
        timeoutMs: config.timeoutMs,
        fetchImpl: fetch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        saveImage: noPersist,
      }),
    } },
    ...config.reviewBaseUrl.trim() === '' ? {} : { reviewOverride: {
      id: `image-iterate-review-override:${provider}`,
      provider,
      model: config.reviewModel,
      label: 'Configured OpenAI-compatible review route',
      review: async request => reviewImage(await reviewConfig(), request.image, request.acceptanceCriteria, {
        timeoutMs: config.timeoutMs,
        fetchImpl: fetch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        saveImage: noPersist,
      }),
    } },
  }
}

function asHarnessError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error
  const code = error instanceof ImageIterateError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof TypeError
        ? 'INVALID_CONFIG'
        : 'IMAGE_ITERATE_FAILED'
  const message = error instanceof Error ? error.message : '图像生成或审核未完成。'
  return new HarnessError(message, code, { cause: error })
}

function projectImage(ref: ImageAttachmentRef): ImageToolResult['image'] {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function imageFromMeta(value: unknown): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const image = value as Record<string, unknown>
  const attachmentId = image.attachmentId
  const mediaType = image.mediaType
  const bytes = image.bytes
  const width = image.width
  const height = image.height
  if (typeof attachmentId !== 'string' || attachmentId === ''
    || !isImageMediaType(mediaType)
    || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1
    || typeof width !== 'number' || !Number.isInteger(width) || width < 1
    || typeof height !== 'number' || !Number.isInteger(height) || height < 1) return undefined
  const original = image.originalDimensions
  let originalDimensions: ImageAttachmentRef['originalDimensions']
  if (original !== undefined) {
    if (typeof original !== 'object' || original === null) return undefined
    const dimensions = original as Record<string, unknown>
    const originalWidth = dimensions.width
    const originalHeight = dimensions.height
    if (typeof originalWidth !== 'number' || !Number.isInteger(originalWidth) || originalWidth < 1
      || typeof originalHeight !== 'number' || !Number.isInteger(originalHeight) || originalHeight < 1) return undefined
    originalDimensions = { width: originalWidth, height: originalHeight }
  }
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
    ...(typeof image.name === 'string' ? { name: image.name } : {}),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

/** Register the image generation and independent visual review tool. */
export function apply(ctx: Context, config: Config): void {
  provideImageCapabilityRegistry(ctx)
  ctx.systemPrompt.section({
    name: 'tool:generate_image_with_review',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES') + 1,
    text: ({ scope, toolSet }) => ctx.tools.definitions(scope, toolSet).some(tool => tool.name === 'generate_image_with_review')
      ? 'When the user explicitly asks you to create an image, call generate_image_with_review before answering. Derive acceptance criteria from the request. Only report the image as generated after a successful tool result includes a saved image attachment. If review did not pass or was unavailable, say so. Report tool failures and unknown outcomes honestly; do not retry a failed call automatically. The tool handles review and any bounded regeneration itself.'
      : '',
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'generate_image_with_review',
    description: 'Use this tool when the user explicitly asks you to create an image. It saves an image attachment and visually reviews it against acceptance criteria. Only say an image was generated when this tool returns a saved attachment. Do not automatically retry a failed or unknown outcome.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete image-generation prompt.' },
      acceptance_criteria: { type: 'string', required: true, description: 'Observable requirements the visual reviewer must check.' },
      size: { type: 'string', description: 'Optional OpenAI-compatible image size. Omit to use the configured default.' },
      quality: { type: 'string', description: 'Optional OpenAI-compatible image quality. Omit to use the configured default.' },
    },
    output: {
      schema: resultSchema,
      render: (_args: ImageToolArgs, value: ImageToolResult) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: ImageToolArgs, value: ImageToolResult) => ({ kind: 'image-iterate-result', image: value.image }),
    },
    presentResult: (_args: ImageToolArgs, result: ToolResult) => {
      const meta = typeof result.meta === 'object' && result.meta !== null ? result.meta as Record<string, unknown> : undefined
      const image = imageFromMeta(meta?.image)
      if (result.isError || image === undefined) return undefined
      return { card: 'generic', content: [{ type: 'image', attachment: image }] }
    },
    async execute(args: ImageToolArgs, exec): Promise<ImageToolResult> {
      try {
        const runtimeConfig = ensureConfig(config)
        const outputFormat = runtimeConfig.outputFormat as OutputFormat
        const imageOverride = runtimeConfig.imageBaseUrl.trim() !== ''
        const reviewOverride = runtimeConfig.reviewBaseUrl.trim() !== ''
        const size = args.size ?? runtimeConfig.defaultSize
        const quality = args.quality ?? runtimeConfig.defaultQuality
        let automatic
        if (!imageOverride || !reviewOverride) {
          if (exec.agent === undefined) {
            throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '当前工具调用没有可用的 agent，无法继承聊天 provider。')
          }
          const provider = exec.agent.model.current()?.provider ?? ''
          automatic = await resolveImageCapability(ctx, exec.agent, size, quality, exec.signal,
            configuredCapabilities(ctx, provider, runtimeConfig, outputFormat))
        }
        const resolvedSize = automatic?.size ?? size
        const resolvedQuality = automatic?.quality ?? quality
        if (resolvedSize.trim() === '' || resolvedQuality.trim() === '') {
          throw new ImageIterateError('MISSING_CONFIG', '图像 size 和 quality 无法确定，请通过工具参数、插件默认值或用户问询提供。')
        }
        const selected = automatic === undefined
          ? undefined
          : capabilityConfig(automatic.capability, automatic.review, resolvedSize, resolvedQuality, outputFormat)
        const image = automatic === undefined && imageOverride
          ? {
            baseUrl: runtimeConfig.imageBaseUrl,
            model: runtimeConfig.imageModel,
            token: await resolveCredential(ctx, runtimeConfig.imageCredential, '图像生成'),
            size: resolvedSize,
            quality: resolvedQuality,
            outputFormat,
          }
          : selected === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '图像 capability 未解析。') })()
            : selected.image
        const review = automatic === undefined && reviewOverride
          ? {
            baseUrl: runtimeConfig.reviewBaseUrl,
            model: runtimeConfig.reviewModel,
            token: await resolveCredential(ctx, runtimeConfig.reviewCredential, '视觉审核'),
          }
          : selected === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '审核 capability 未解析。') })()
            : selected.review
        const result = await generateAndReview({
          maxIterations: runtimeConfig.maxIterations,
          image,
          review,
        }, {
          prompt: args.prompt,
          acceptanceCriteria: args.acceptance_criteria,
        }, {
          signal: exec.signal,
          timeoutMs: runtimeConfig.timeoutMs,
          fetchImpl: fetch,
          imageOutcomeUnknown: cause => new ImageGenerationOutcomeUnknownError(cause),
          saveImage: async (image, iteration) => ctx.attachments.saveImage({
            data: image.bytes,
            mediaType: image.mimeType,
            name: `image-review-${Date.now()}-${iteration}.${outputFormat === 'jpeg' ? 'jpg' : outputFormat}`,
          }),
        })
        return {
          image: projectImage(result.attachment),
          iteration: result.iteration,
          accepted: result.accepted,
          review_status: result.reviewStatus,
          feedback: result.feedback,
        }
      } catch (error) {
        throw asHarnessError(error)
      }
    },
  })), 'image-iterate-plugin: image review tool')
}

class ImageGenerationOutcomeUnknownError extends HarnessError {
  constructor(cause: unknown) {
    super(IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE, IMAGE_GENERATION_OUTCOME_UNKNOWN, { cause })
  }
}

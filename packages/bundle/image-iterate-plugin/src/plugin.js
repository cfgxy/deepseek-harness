import Schema from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  IMAGE_GENERATION_OUTCOME_UNKNOWN,
  IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE,
  ImageIterateError,
  generateAndReview,
} from './api.js'
import { capabilityConfig, ImageCapabilityError, resolveImageCapability } from './capability.js'

export const name = 'image-iterate-plugin'
export const inject = ['tools', 'attachments', 'credentials', 'llm', 'userQuestions']

export const Config = Schema.object({
  imageBaseUrl: Schema.string().default(''),
  imageModel: Schema.string().default(''),
  imageCredential: Schema.string().default(''),
  reviewBaseUrl: Schema.string().default(''),
  reviewModel: Schema.string().default(''),
  reviewCredential: Schema.string().default(''),
  maxIterations: Schema.number().default(2),
  timeoutMs: Schema.number().default(120000),
  defaultSize: Schema.string().default('1024x1024'),
  defaultQuality: Schema.string().default('medium'),
  outputFormat: Schema.string().default('png'),
})

const imageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
}

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { ...imageSchema, required: true },
    iteration: { type: 'integer', required: true },
    accepted: { type: 'boolean', required: true },
    review_status: { type: 'string', required: true },
    feedback: { type: 'string', required: true },
  },
}

function ensureConfig(config) {
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 3) {
    throw new ImageIterateError('INVALID_CONFIG', 'maxIterations 必须是 1 到 3 的整数。')
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) {
    throw new ImageIterateError('INVALID_CONFIG', 'timeoutMs 必须是不小于 1000 的整数。')
  }
  if (!['png', 'webp', 'jpeg'].includes(config.outputFormat)) {
    throw new ImageIterateError('INVALID_CONFIG', 'outputFormat 仅支持 png、webp 或 jpeg。')
  }
  const imageOverride = [config.imageBaseUrl, config.imageModel, config.imageCredential]
  const reviewOverride = [config.reviewBaseUrl, config.reviewModel, config.reviewCredential]
  for (const [role, values] of [['图像生成', imageOverride], ['视觉审核', reviewOverride]]) {
    const configured = values.filter(value => value.trim() !== '').length
    if (configured !== 0 && configured !== values.length) {
      throw new ImageIterateError('INVALID_CONFIG', `${role} override 必须同时配置 endpoint、model 和 credential reference。`)
    }
  }
  return config.outputFormat
}

async function resolveCredential(ctx, reference, role) {
  if (!isCredentialRefName(reference)) {
    throw new ImageIterateError('INVALID_CONFIG', `${role}凭据引用必须是 POSIX 环境变量名称。`)
  }
  const resolved = await ctx.credentials.resolve(credentialRef(reference))
  if (resolved === undefined || resolved.value.trim() === '') {
    throw new ImageIterateError('MISSING_CREDENTIAL', `${role}凭据 ${reference} 未配置。请通过 DSH 凭据服务或启动环境设置它。`)
  }
  return resolved.value
}

function asHarnessError(error) {
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

function projectImage(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

class ImageGenerationOutcomeUnknownError extends HarnessError {
  constructor(cause) {
    super(IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE, IMAGE_GENERATION_OUTCOME_UNKNOWN, { cause })
  }
}

export function apply(ctx, config) {
  return ctx.effect(() => ctx.tools.register(defineTool({
    name: 'generate_image_with_review',
    description: 'Generate one image through the current chat provider when it exposes a provider-owned image capability, review it against explicit acceptance criteria, and retry only when that review rejects it. Explicit endpoint/model/credential overrides remain available for advanced deployments; ask the user when capability selection is ambiguous. The configured limit prevents unbounded paid requests.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete image-generation prompt.' },
      acceptance_criteria: { type: 'string', required: true, description: 'Observable requirements the visual reviewer must check.' },
      size: { type: 'string', description: 'Optional OpenAI-compatible image size. Omit to use the configured default.' },
      quality: { type: 'string', description: 'Optional OpenAI-compatible image quality. Omit to use the configured default.' },
    },
    output: {
      schema: resultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ image: value.image }),
    },
    presentResult: (_args, result) => {
      const image = result.meta?.image
      if (result.isError || image === undefined) return undefined
      return { card: 'generic', content: [{ type: 'image', attachment: image }] }
    },
    async execute(args, exec) {
      try {
        const outputFormat = ensureConfig(config)
        const imageOverride = config.imageBaseUrl.trim() !== ''
        const reviewOverride = config.reviewBaseUrl.trim() !== ''
        const size = args.size ?? config.defaultSize
        const quality = args.quality ?? config.defaultQuality
        const automatic = imageOverride && reviewOverride
          ? undefined
          : exec.agent === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '当前工具调用没有可用的 agent，无法继承聊天 provider。') })()
            : await resolveImageCapability(ctx, exec.agent, size, quality, exec.signal)
        const resolvedSize = automatic?.size ?? size
        const resolvedQuality = automatic?.quality ?? quality
        if (resolvedSize.trim() === '' || resolvedQuality.trim() === '') {
          throw new ImageIterateError('MISSING_CONFIG', '图像 size 和 quality 无法确定，请通过工具参数、插件默认值或用户问询提供。')
        }
        const selected = automatic === undefined
          ? undefined
          : capabilityConfig(automatic.capability, resolvedSize, resolvedQuality, outputFormat)
        const image = imageOverride
          ? {
              baseUrl: config.imageBaseUrl,
              model: config.imageModel,
              token: await resolveCredential(ctx, config.imageCredential, '图像生成'),
              size: resolvedSize,
              quality: resolvedQuality,
              outputFormat,
            }
          : selected === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '图像 capability 未解析。') })()
            : selected.image
        const review = reviewOverride
          ? {
              baseUrl: config.reviewBaseUrl,
              model: config.reviewModel,
              token: await resolveCredential(ctx, config.reviewCredential, '视觉审核'),
            }
          : selected === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '审核 capability 未解析。') })()
            : selected.review
        const result = await generateAndReview({
          maxIterations: config.maxIterations,
          image,
          review,
        }, {
          prompt: args.prompt,
          acceptanceCriteria: args.acceptance_criteria,
        }, {
          signal: exec.signal,
          timeoutMs: config.timeoutMs,
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

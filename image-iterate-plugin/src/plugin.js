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

export const name = 'image-iterate-plugin'
export const inject = ['tools', 'attachments', 'credentials']

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
  for (const field of ['imageBaseUrl', 'imageModel', 'imageCredential', 'reviewBaseUrl', 'reviewModel', 'reviewCredential']) {
    if (config[field].trim() === '') throw new ImageIterateError('MISSING_CONFIG', `缺少 ${field} 配置。请在 profile 的 cordis.patch.yml 中设置它。`)
  }
}

async function resolveCredential(ctx, reference, role) {
  if (!isCredentialRefName(reference)) {
    throw new ImageIterateError('INVALID_CONFIG', `${role}凭据引用必须是 POSIX 环境变量名称。`)
  }
  const resolved = await ctx.credentials.resolve(credentialRef(reference))
  if (resolved === undefined || resolved.value.trim() === '') throw new ImageIterateError('MISSING_CREDENTIAL', `${role}凭据 ${reference} 未配置。请通过 DSH 凭据服务或启动环境设置它。`)
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
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...ref.originalDimensions } }),
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
    description: 'Generate one image with the configured OpenAI-compatible Images API, review it against explicit acceptance criteria with the separately configured visual model, and retry only when that review rejects it. The configured limit prevents unbounded paid requests. Use this when the user asks to create an image and gives or can answer acceptance criteria.',
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
        ensureConfig(config)
        const [imageToken, reviewToken] = await Promise.all([
          resolveCredential(ctx, config.imageCredential, '图像生成'),
          resolveCredential(ctx, config.reviewCredential, '视觉审核'),
        ])
        const result = await generateAndReview({
          maxIterations: config.maxIterations,
          image: {
            baseUrl: config.imageBaseUrl,
            model: config.imageModel,
            token: imageToken,
            size: args.size ?? config.defaultSize,
            quality: args.quality ?? config.defaultQuality,
            outputFormat: config.outputFormat,
          },
          review: { baseUrl: config.reviewBaseUrl, model: config.reviewModel, token: reviewToken },
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
            name: `image-review-${Date.now()}-${iteration}.${config.outputFormat === 'jpeg' ? 'jpg' : config.outputFormat}`,
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

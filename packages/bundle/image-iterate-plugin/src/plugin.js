import Schema from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  IMAGE_GENERATION_OUTCOME_UNKNOWN,
  IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE,
  ImageIterateError,
  generateAndReview,
  generateImage,
  reviewImage,
} from './api.js'
import { capabilityConfig, ImageCapabilityError, provideImageCapabilityRegistry, resolveImageCapability } from './capability.js'

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
  const snapshot = {
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
  for (const [role, values] of [['图像生成', imageOverride], ['视觉审核', reviewOverride]]) {
    const configured = values.filter(value => value.trim() !== '').length
    if (configured !== 0 && configured !== values.length) {
      throw new ImageIterateError('INVALID_CONFIG', `${role} override 必须同时配置 endpoint、model 和 credential reference。`)
    }
  }
  return snapshot
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

function registerConfiguredCapability(ctx, provider, config, outputFormat) {
  const noPersist = async () => {
    throw new ImageIterateError('IMAGE_ITERATE_FAILED', '单次 provider capability 不应直接持久化图像。')
  }
  const imageConfig = async (size, quality) => ({
    baseUrl: config.imageBaseUrl,
    model: config.imageModel,
    token: await resolveCredential(ctx, config.imageCredential, '图像生成'),
    size,
    quality,
    outputFormat,
  })
  const reviewConfig = async () => ({
    baseUrl: config.reviewBaseUrl,
    model: config.reviewModel,
    token: await resolveCredential(ctx, config.reviewCredential, '视觉审核'),
  })
  const registry = ctx.get('imageCapabilities')
  if (registry === undefined) throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '图像 capability registry 尚未提供。')
  return registry.register({
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
    review: async request => reviewImage(await reviewConfig(), request.image, request.acceptanceCriteria, {
      timeoutMs: config.timeoutMs,
      fetchImpl: fetch,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      saveImage: noPersist,
    }),
  })
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
  provideImageCapabilityRegistry(ctx)
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
      let configuredDisposer
      try {
        const runtimeConfig = ensureConfig(config)
        const outputFormat = runtimeConfig.outputFormat
        const imageOverride = runtimeConfig.imageBaseUrl.trim() !== ''
        const reviewOverride = runtimeConfig.reviewBaseUrl.trim() !== ''
        const size = args.size ?? runtimeConfig.defaultSize
        const quality = args.quality ?? runtimeConfig.defaultQuality
        let automatic
        if (imageOverride && reviewOverride && exec.agent !== undefined) {
          const current = exec.agent.model.current()
          if (current?.provider !== undefined && current.provider.trim() !== '') {
            configuredDisposer = registerConfiguredCapability(ctx, current.provider, runtimeConfig, outputFormat)
            automatic = await resolveImageCapability(ctx, exec.agent, size, quality, exec.signal)
          }
        } else if (!imageOverride || !reviewOverride) {
          automatic = exec.agent === undefined
            ? (() => { throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '当前工具调用没有可用的 agent，无法继承聊天 provider。') })()
            : await resolveImageCapability(ctx, exec.agent, size, quality, exec.signal)
        }
        const resolvedSize = automatic?.size ?? size
        const resolvedQuality = automatic?.quality ?? quality
        if (resolvedSize.trim() === '' || resolvedQuality.trim() === '') {
          throw new ImageIterateError('MISSING_CONFIG', '图像 size 和 quality 无法确定，请通过工具参数、插件默认值或用户问询提供。')
        }
        const selected = automatic === undefined
          ? undefined
          : capabilityConfig(
              automatic.capability,
              automatic.review,
              resolvedSize,
              resolvedQuality,
              outputFormat,
            )
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
      } finally {
        configuredDisposer?.()
      }
    },
  })), 'image-iterate-plugin: image review tool')
}

export class ImageCapabilityError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ImageCapabilityError'
    this.code = code
  }
}

function modelLabel(info) {
  return info.name === info.id ? info.id : `${info.name} (${info.id})`
}

function answerSelection(answer, id) {
  const item = answer.answers.find(entry => entry.id === id)
  const selected = item?.selected[0]
  if (selected !== undefined && selected.trim() !== '') return selected.trim()
  const custom = item?.custom?.trim()
  return custom === '' ? undefined : custom
}

async function askSelection(ctx, agent, signal, request) {
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

async function askForCapability(ctx, agent, signal, candidates, provider, currentModel) {
  return askSelection(ctx, agent, signal, {
    id: 'image-capability',
    header: '图像能力',
    question: candidates.length === 0
      ? `当前聊天 provider「${provider}」的模型「${currentModel}」没有声明可用的图像生成能力，请提供已注册的 capability id。`
      : '请选择用于图像生成和视觉审核的 provider-owned capability。',
    detail: '插件不会读取或记录 provider 的原始凭据；只有 provider 注册的受控生成和审核操作会被调用。',
    ...(candidates.length === 0 ? {} : {
      options: candidates.map(candidate => ({ label: candidate.id, description: candidate.label })),
    }),
  })
}

async function resolveControl(ctx, agent, signal, capability, kind, value) {
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

async function resolveModel(ctx, provider, model, signal) {
  // 同时读取 provider 目录和精确模型元数据；能力判断不检查模型名称。
  await ctx.llm.listModels(provider)
  return ctx.llm.resolveModelInfo(provider, model, signal)
}

export async function resolveImageCapability(ctx, agent, size, quality, signal) {
  const current = agent.model.current()
  if (current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string'
    || current.provider.trim() === '' || current.model.trim() === '') {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '当前聊天没有可确定的 provider/model 路由。')
  }

  let model
  try {
    model = await resolveModel(ctx, current.provider, current.model, signal)
  } catch (error) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '无法读取当前聊天模型的能力元数据。', { cause: error })
  }

  const registry = ctx.imageCapabilities
  const candidates = registry === undefined ? [] : [...await registry.list(current.provider)]
    .filter(candidate => candidate.provider === current.provider)
  const exact = candidates.filter(candidate => candidate.model === current.model)
  let selected
  if (exact.length === 1) selected = exact[0]
  else {
    const selectedId = await askForCapability(
      ctx,
      agent,
      signal,
      exact.length > 1 ? exact : candidates,
      current.provider,
      current.model,
    )
    const selectable = exact.length > 1 ? exact : candidates
    selected = selectable.find(candidate => candidate.id === selectedId)
  }
  if (selected === undefined) {
    throw new ImageCapabilityError('CAPABILITY_UNAVAILABLE', '问询选择的图像 capability 不存在或不属于当前 provider。')
  }
  const resolvedSize = await resolveControl(ctx, agent, signal, selected, 'size', size)
  const resolvedQuality = await resolveControl(ctx, agent, signal, selected, 'quality', quality)
  return { capability: selected, model, size: resolvedSize, quality: resolvedQuality }
}

export function capabilityConfig(capability, size, quality, outputFormat) {
  return {
    image: {
      generate: (prompt, signal) => capability.generate({
        prompt,
        size,
        quality,
        outputFormat,
        ...(signal === undefined ? {} : { signal }),
      }),
    },
    review: {
      review: (image, acceptanceCriteria, signal) => capability.review({
        image,
        acceptanceCriteria,
        ...(signal === undefined ? {} : { signal }),
      }),
    },
  }
}

export { modelLabel }

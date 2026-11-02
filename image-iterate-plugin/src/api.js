export class ImageIterateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ImageIterateError'
    this.code = code
  }
}

function endpoint(baseUrl, path) {
  try {
    return new URL(path, `${baseUrl.replace(/\/+$/, '')}/`).toString()
  } catch {
    throw new ImageIterateError('INVALID_CONFIG', '上游 endpoint 必须是合法的绝对 URL。')
  }
}

async function requestJson(url, token, body, { signal, timeoutMs, fetchImpl }) {
  if (signal?.aborted) throw new ImageIterateError('CANCELLED', '图像任务已取消，未发起上游请求。')

  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let submitted = false

  try {
    submitted = true
    const response = await fetchImpl(url, {
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
    } catch {
      throw new ImageIterateError('INVALID_UPSTREAM_RESPONSE', '上游返回了非 JSON 响应。')
    }
  } catch (error) {
    if (error instanceof ImageIterateError) throw error
    if (submitted) {
      const reason = signal?.aborted
        ? '图像任务已取消'
        : controller.signal.aborted
          ? `上游请求在 ${timeoutMs}ms 内未完成`
          : '无法连接图像或视觉审核上游'
      throw new ImageIterateError('UPSTREAM_OUTCOME_UNKNOWN', `${reason}。无法确认上游是否已接受请求，因此不会自动重试。`)
    }
    throw new ImageIterateError('UPSTREAM_UNREACHABLE', '无法连接图像或视觉审核上游。')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function decodeImage(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ImageIterateError('INVALID_UPSTREAM_RESPONSE', '上游未返回有效的 b64_json 图像内容。')
  }
  return Buffer.from(value, 'base64')
}

function parseReview(value) {
  const content = typeof value === 'string' ? value.trim().replace(/^```(?:json)?\s*|\s*```$/g, '') : ''
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed.accepted !== 'boolean' || typeof parsed.feedback !== 'string') throw new TypeError('bad review')
    return { accepted: parsed.accepted, feedback: parsed.feedback.trim() }
  } catch {
    throw new ImageIterateError('INVALID_REVIEW_RESPONSE', '视觉审核未返回 {"accepted": boolean, "feedback": string} JSON。')
  }
}

export async function generateImage(config, prompt, options) {
  const payload = await requestJson(endpoint(config.baseUrl, 'images/generations'), config.token, {
    model: config.model,
    prompt,
    n: 1,
    size: config.size,
    quality: config.quality,
    output_format: config.outputFormat,
  }, options)
  const image = payload?.data?.[0]?.b64_json
  return { bytes: decodeImage(image), mimeType: `image/${config.outputFormat}` }
}

export async function reviewImage(config, image, acceptanceCriteria, options) {
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
  }, options)
  return parseReview(payload?.choices?.[0]?.message?.content)
}

function revisionPrompt(prompt, feedback) {
  return `${prompt}\n\n请根据以下审核反馈修改：${feedback}`
}

export async function generateAndReview(config, request, options) {
  let prompt = request.prompt
  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const image = await generateImage(config.image, prompt, options)
    const attachment = await options.saveImage(image, iteration)
    let review
    try {
      review = await reviewImage(config.review, image, request.acceptanceCriteria, options)
    } catch (error) {
      if (error instanceof ImageIterateError) {
        return { attachment, iteration, accepted: false, reviewStatus: 'review_unavailable', feedback: error.message }
      }
      throw error
    }
    if (review.accepted) return { attachment, iteration, accepted: true, reviewStatus: 'accepted', feedback: review.feedback }
    if (iteration === config.maxIterations) {
      return { attachment, iteration, accepted: false, reviewStatus: 'rejected_at_limit', feedback: review.feedback }
    }
    prompt = revisionPrompt(request.prompt, review.feedback)
  }
  throw new ImageIterateError('INVALID_CONFIG', 'maxIterations 必须为正整数。')
}

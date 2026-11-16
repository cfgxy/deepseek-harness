import { provideImageCapabilityRegistry } from '../../../../../../packages/bundle/image-iterate-plugin/lib/index.js'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const REVIEW_MODEL = 'fixture-vision'
const TOKEN = 'fixture-token'

export const name = 'fixture-image-provider'

async function post(baseUrl, path, body, signal) {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/+$/, '')}/`), {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`fixture image provider HTTP ${response.status}`)
  return response.json()
}

/**
 * Test-only provider adapter: the endpoint is supplied by the test-owned loopback
 * server, while the registry owns the generation and review closures.
 */
export function apply(ctx) {
  const baseUrl = process.env.DSH_IMAGE_FIXTURE_BASE_URL
  if (baseUrl === undefined || baseUrl === '') {
    throw new Error('fixture image provider requires DSH_IMAGE_FIXTURE_BASE_URL')
  }
  const registry = provideImageCapabilityRegistry(ctx)
  ctx.effect(() => registry.register({
    id: 'fixture-image-route',
    provider: PROVIDER,
    model: MODEL,
    label: 'Fixture provider image route',
    sizes: ['1024x1024'],
    qualities: ['medium'],
    generate: async request => {
      const payload = await post(baseUrl, 'images/generations', {
        model: MODEL,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        quality: request.quality,
        output_format: request.outputFormat,
      }, request.signal)
      const encoded = payload?.data?.[0]?.b64_json
      if (typeof encoded !== 'string' || encoded === '') throw new Error('fixture image provider returned no image')
      return { bytes: Buffer.from(encoded, 'base64'), mimeType: `image/${request.outputFormat}` }
    },
    review: async request => {
      const payload = await post(baseUrl, 'chat/completions', {
        model: REVIEW_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return JSON.' },
          { role: 'user', content: [
            { type: 'text', text: request.acceptanceCriteria },
            { type: 'image_url', image_url: { url: `data:${request.image.mimeType};base64,${request.image.bytes.toString('base64')}` } },
          ] },
        ],
      }, request.signal)
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('fixture image provider returned no review')
      return JSON.parse(content)
    },
  }), 'fixture image provider capability')
}

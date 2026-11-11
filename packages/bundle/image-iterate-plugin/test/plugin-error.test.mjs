import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

test('Host 工具将已发出图片 POST 的未知结果保留为可持久化 HarnessError', async () => {
  const source = await readFile(new URL('../src/plugin.js', import.meta.url), 'utf8')
  const transformed = source
    .replace("import Schema from '@deepseek-ai/schemastery'", '')
    .replace("import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'", '')
    .replace("import { HarnessError } from '@deepseek-ai/dsh-llm'", '')
    .replace("import { defineTool } from '@deepseek-ai/dsh-tools'", '')
    .replace(/import \{[\s\S]*?\} from '\.\/api\.js'/, '')
    .replace('export const name', 'const name')
    .replace('export const inject', 'const inject')
    .replace('export const Config', 'const Config')
    .replace('export function apply', 'function apply')
    .concat('\n;globalThis.__apply = apply')
  const cause = new Error('socket closed')
  const generateAndReview = async (_config, _request, options) => {
    throw options.imageOutcomeUnknown(cause)
  }
  const context = {
    Schema: { object: value => value, string: () => ({ default: value => value }), number: () => ({ default: value => value }) },
    credentialRef: value => value,
    isCredentialRefName: () => true,
    HarnessError,
    defineTool: value => value,
    ImageIterateError: class ImageIterateError extends Error {},
    IMAGE_GENERATION_OUTCOME_UNKNOWN: 'IMAGE_GENERATION_OUTCOME_UNKNOWN',
    IMAGE_GENERATION_OUTCOME_UNKNOWN_MESSAGE: '图像生成请求可能已被上游接受并产生计费，但结果无法确认。禁止自动重试；请先在上游控制台或账单记录中核对结果。',
    generateAndReview,
    fetch: () => assert.fail('不应调用 fetch'),
  }
  vm.runInNewContext(transformed, context)
  let definition
  const ctx = {
    effect(callback) { return callback() },
    tools: { register(value) { definition = value; return () => {} } },
    credentials: { resolve: async () => ({ value: 'token' }) },
    attachments: { saveImage: async () => assert.fail('不应保存图片') },
  }
  context.__apply(ctx, {
    imageBaseUrl: 'https://image.example/v1', imageModel: 'image', imageCredential: 'IMAGE_TOKEN',
    reviewBaseUrl: 'https://review.example/v1', reviewModel: 'review', reviewCredential: 'REVIEW_TOKEN',
    maxIterations: 1, timeoutMs: 1_000, defaultSize: '1024x1024', defaultQuality: 'medium', outputFormat: 'png',
  })
  await assert.rejects(() => definition.execute({ prompt: 'square', acceptance_criteria: 'blue' }, { signal: new AbortController().signal }), error => {
    assert.equal(error instanceof HarnessError, true)
    assert.equal(error.code, 'IMAGE_GENERATION_OUTCOME_UNKNOWN')
    assert.equal(error.cause, cause)
    return true
  })
})

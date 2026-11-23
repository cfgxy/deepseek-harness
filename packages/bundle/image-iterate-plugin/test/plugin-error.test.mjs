import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/plugin.ts'

test('explicit routes preserve the unknown result of a submitted image request', async (t) => {
  const cause = new Error('socket closed')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw cause })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let definition
  ctx.provide('systemPrompt', { section() {}, getSectionOrder: () => 0 })
  ctx.provide('tools', { register(value) { definition = value; return () => {} } })
  ctx.provide('credentials', { resolve: async () => ({ value: 'token' }) })
  ctx.provide('attachments', { saveImage: async () => assert.fail('must not save an image') })
  const volatile = value => ({ get: () => value })
  apply(ctx, {
    imageBaseUrl: volatile('https://image.example/v1'), imageModel: volatile('image'), imageCredential: volatile('IMAGE_TOKEN'),
    reviewBaseUrl: volatile('https://review.example/v1'), reviewModel: volatile('review'), reviewCredential: volatile('REVIEW_TOKEN'),
    maxIterations: volatile(2), timeoutMs: volatile(1_000), defaultSize: volatile('1024x1024'), defaultQuality: volatile('medium'), outputFormat: volatile('png'),
  })
  await assert.rejects(() => definition.execute({ prompt: 'square', acceptance_criteria: 'blue' }, {
    agent: { model: { current: () => assert.fail('explicit routes must not consult the chat model') } },
    signal: new AbortController().signal,
  }), error => error instanceof HarnessError && error.code === 'IMAGE_GENERATION_OUTCOME_UNKNOWN' && error.cause === cause)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://image.example/v1/images/generations')
})

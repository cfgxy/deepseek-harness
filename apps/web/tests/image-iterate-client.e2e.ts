// @vitest-environment jsdom
// The shipped image-review client bundle must travel through the same WebBootGraph
// and ModuleLoader path as the Web/Desktop installation. The fixture result carries
// the durable tool metadata that the Host stores after the attachment save completes.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'
import type { AssembledEventRecord } from './assembled-remote.ts'

installAssembledBootEnv()

const attachment = {
  attachmentId: 'image-review-fixture',
  mediaType: 'image/png',
  bytes: 247,
  width: 160,
  height: 90,
  name: 'image-review-fixture.png',
  originalDimensions: { width: 320, height: 180 },
} as const

const imageResult: readonly AssembledEventRecord[] = [
  {
    type: 'event',
    event: {
      seq: 553,
      time: 1_789_265_800_000,
      type: 'turn/start',
      data: { turn: 75 },
    },
  },
  {
    type: 'event',
    event: {
      seq: 554,
      time: 1_789_265_800_100,
      type: 'step/start',
      data: { turn: 75, step: 0 },
    },
  },
  {
    type: 'event',
    event: {
      seq: 555,
      time: 1_789_265_800_200,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 75,
        step: 0,
        stream: [],
        message: {
          id: 'image-review-call-message',
          role: 'assistant',
          source: { kind: 'model', provider: 'fixture', model: 'fx-1' },
          content: [{
            type: 'tool-call',
            id: 'image-review-call',
            name: 'generate_image_with_review',
            arguments: '{"prompt":"fixture","acceptance_criteria":"fixture"}',
          }],
        },
      },
    },
  },
  {
    type: 'event',
    event: {
      seq: 556,
      time: 1_789_265_800_300,
      type: 'tool/call',
      data: {
        turn: 75,
        step: 0,
        callId: 'image-review-call',
        name: 'generate_image_with_review',
        arguments: '{"prompt":"fixture","acceptance_criteria":"fixture"}',
      },
    },
  },
  {
    type: 'event',
    event: {
      seq: 557,
      time: 1_789_265_800_400,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 75,
        step: 0,
        meta: {
          image: attachment,
        },
        message: {
          id: 'image-review-result',
          role: 'tool',
          toolCallId: 'image-review-call',
          source: { kind: 'tool', callId: 'image-review-call' },
          content: [{ type: 'text', text: 'complete' }],
          isError: false,
        },
      },
    },
  },
  {
    type: 'event',
    event: {
      seq: 558,
      time: 1_789_265_800_500,
      type: 'step/end',
      data: { turn: 75, step: 0 },
    },
  },
  {
    type: 'event',
    event: {
      seq: 559,
      time: 1_789_265_800_600,
      type: 'turn/end',
      data: { turn: 75, reason: { kind: 'completed' } },
    },
  },
]

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function isImageReviewAttachmentRead(value: unknown): boolean {
  const call = record(value)
  const args = call === undefined ? undefined : call.args
  if (!Array.isArray(args)) return false
  const envelope = record(args[0])
  const request = envelope === undefined ? undefined : record(envelope.request)
  const actual = request === undefined ? undefined : record(request.attachment)
  const originalDimensions = actual === undefined ? undefined : record(actual.originalDimensions)
  return actual?.attachmentId === attachment.attachmentId
    && actual.mediaType === attachment.mediaType
    && actual.bytes === attachment.bytes
    && actual.width === attachment.width
    && actual.height === attachment.height
    && actual.name === attachment.name
    && originalDimensions?.width === attachment.originalDimensions.width
    && originalDimensions.height === attachment.originalDimensions.height
}

async function openFixtureHistory(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === undefined || group === null) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  await waitFor(() => {
    expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
  }, { timeout: 10_000 })
}

it('loads a persistent image-review attachment through the shipped Web bundle', async () => {
  const remote = mountAssembledApp({
    remote: {
      alphaRecords: imageResult,
      attachmentAliases: { 'image-review-fixture': 'fixture:image' },
    },
  })
  await openFixtureHistory()

  const row = await waitFor(() => {
    const value = document.querySelector<HTMLElement>('[data-chat-call-id="image-review-call"]')
    if (value === null) {
      const calls = [...document.querySelectorAll<HTMLElement>('[data-chat-call-id]')]
        .map(element => element.getAttribute('data-chat-call-id'))
      const boot = Reflect.get(window, '__DSH_BOOT__') as { entries?: { id?: string }[] } | undefined
      const pluginLoaded = boot?.entries?.some(entry => entry.id === '@deepseek-ai/dsh-image-iterate-plugin') === true
      throw new Error(`image review tool row missing; visible calls=${JSON.stringify(calls)}; plugin entry=${String(pluginLoaded)}`)
    }
    return value
  }, { timeout: 10_000 })
  const toggle = row.querySelector<HTMLElement>('[data-expandable]')
  if (toggle !== null) fireEvent.click(toggle)

  const image = await waitFor(() => {
    const value = row.querySelector<HTMLImageElement>('img[alt="image-review-fixture.png"]')
    if (value === null) throw new Error('image review attachment missing')
    return value
  })
  expect(image.getAttribute('src')?.split(':')[0]).toBe('blob')
  await waitFor(() => {
    expect(remote.mock.log.calls('session/attachment').some(isImageReviewAttachmentRead)).toBe(true)
  })
})

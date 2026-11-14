// @vitest-environment jsdom
// The default image-review client bundle must travel through the same WebBootGraph
// and ModuleLoader path as the Web/Desktop installation. The fixture result carries
// the durable tool metadata that the Host stores after the attachment save completes.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import {
  installAssembledBootEnv,
  mountAssembledApp,
  type AdditionalAssembledPlugin,
} from './assembled-boot.ts'
import type { AssembledEventRecord } from './assembled-remote.ts'

installAssembledBootEnv()

interface ImageReviewManifest {
  readonly name?: unknown
  readonly exports?: { readonly './client'?: unknown }
  readonly dependencies?: Record<string, unknown>
  readonly peerDependencies?: Record<string, unknown>
  readonly devDependencies?: Record<string, unknown>
  readonly dsh?: {
    readonly client?: {
      readonly platform?: unknown
      readonly inject?: unknown
    }
  }
}

const imageReviewManifestPath = resolve(import.meta.dirname, '../../../packages/bundle/image-iterate-plugin/package.json')

function loadImageReviewClient(manifest: ImageReviewManifest): AdditionalAssembledPlugin {
  const name = manifest.name
  const clientExport = manifest.exports?.['./client']
  const relativeClientExport = typeof clientExport === 'string'
    ? clientExport
    : record(clientExport)?.default
  const declaration = manifest.dsh?.client
  if (typeof name !== 'string' || typeof relativeClientExport !== 'string') {
    throw new Error('image review plugin must publish a named ./client export')
  }
  if (declaration?.platform !== 'web') {
    throw new Error('image review plugin client must declare the web platform')
  }
  if (!Array.isArray(declaration.inject) || !declaration.inject.every(dependency => typeof dependency === 'string')) {
    throw new Error('image review plugin client must declare injected dependencies')
  }
  const declaredDependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }
  const undeclaredDependency = declaration.inject.find(dependency => !(dependency in declaredDependencies))
  if (undeclaredDependency !== undefined) {
    throw new Error(`image review plugin inject dependency is not declared: ${undeclaredDependency}`)
  }
  return {
    id: name,
    bundlePath: resolve(dirname(imageReviewManifestPath), relativeClientExport),
    url: `plugins/${name}/client.js`,
    rev: 'fixture-image-iterate',
    inject: declaration.inject,
  }
}

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

async function openImageIterateSettings(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Plugins$/ }))
  const card = await waitFor(() => {
    const value = document.querySelector<HTMLElement>('[data-plugin-item="image-iterate-plugin"]')
    if (value === null) throw new Error('image review settings card missing')
    return value
  })
  fireEvent.click(within(card).getByRole('button', { name: /^View Image generation and review$/ }))
  await screen.findByLabelText('Image override API base URL')
}

it('rejects inconsistent published client metadata before assembly', () => {
  const manifest = JSON.parse(readFileSync(imageReviewManifestPath, 'utf8')) as ImageReviewManifest
  expect(() => loadImageReviewClient({ ...manifest, exports: {} })).toThrow(/\.\/client export/u)
  expect(() => loadImageReviewClient({
    ...manifest,
    dsh: { client: { ...manifest.dsh?.client, platform: 'desktop' } },
  })).toThrow(/web platform/u)
  const injected = manifest.dsh?.client?.inject
  if (!Array.isArray(injected) || injected.length === 0 || typeof injected[0] !== 'string') {
    throw new Error('image review plugin fixture is missing its published injection list')
  }
  const { [injected[0]]: _peerOmitted, ...peerDependencies } = manifest.peerDependencies ?? {}
  const { [injected[0]]: _dependencyOmitted, ...dependencies } = manifest.dependencies ?? {}
  const { [injected[0]]: _devDependencyOmitted, ...devDependencies } = manifest.devDependencies ?? {}
  expect(() => loadImageReviewClient({ ...manifest, dependencies, peerDependencies, devDependencies })).toThrow(/not declared/u)
})

it('loads a persistent image-review attachment through the installed client bundle', async () => {
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

it('shows current-provider inheritance when all overrides are blank', async () => {
  mountAssembledApp({
    remote: { imageIterate: {} },
  })

  await openImageIterateSettings()
  expect(await screen.findByText('Leave all override fields blank to inherit the current chat provider. Set endpoint, model, and credential reference together for an advanced override.')).not.toBeNull()
  expect((screen.getByLabelText('Image override API base URL') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Review override API base URL') as HTMLInputElement).value).toBe('')
})

it('saves image-provider settings separately from write-only credentials', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: {} },
  })

  await openImageIterateSettings()
  const imageBaseUrl = screen.getByLabelText('Image override API base URL')
  fireEvent.change(imageBaseUrl, { target: { value: 'https://images.example.test/v1' } })
  fireEvent.change(screen.getByLabelText('Image override model'), { target: { value: 'image-fixture' } })
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'IMAGE_FIXTURE_KEY' } })
  fireEvent.change(screen.getByLabelText('Review override API base URL'), { target: { value: 'https://review.example.test/v1' } })
  fireEvent.change(screen.getByLabelText('Review override model'), { target: { value: 'review-fixture' } })
  fireEvent.change(screen.getByLabelText('Review override credential reference'), { target: { value: 'REVIEW_FIXTURE_KEY' } })
  fireEvent.change(screen.getByLabelText('Image API key'), { target: { value: 'test-image-secret' } })
  fireEvent.change(screen.getByLabelText('Review API key'), { target: { value: 'test-review-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

  await waitFor(() => {
    expect(remote.mock.log.calls('settings/mutate')).toHaveLength(1)
  })
  expect(remote.mock.log.calls('credentials/set')).toHaveLength(2)

  const settingsWrites = remote.mock.log.calls('settings/mutate')
  const settingsPayload = JSON.stringify(settingsWrites)
  expect(settingsPayload).toContain('https://images.example.test/v1')
  expect(settingsPayload).toContain('IMAGE_FIXTURE_KEY')
  expect(settingsPayload).not.toContain('test-image-secret')
  expect(settingsPayload).not.toContain('test-review-secret')
  expect(remote.mock.log.calls('credentials/set').map(call => call.args)).toEqual([
    [{ ref: 'IMAGE_FIXTURE_KEY', value: 'test-image-secret' }],
    [{ ref: 'REVIEW_FIXTURE_KEY', value: 'test-review-secret' }],
  ])
  await waitFor(() => {
    expect(screen.getAllByText('A key is configured.', { exact: true })).toHaveLength(2)
  })
  const imageSecret = screen.getByLabelText('Image API key') as HTMLInputElement
  fireEvent.change(imageSecret, { target: { value: '' } })
  expect(imageSecret.value).toBe('')
  expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(remote.mock.log.calls('credentials/set')).toHaveLength(2)
})

it('does not write credentials when the settings document rejects the ordinary fields', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: { mutationsAccepted: false } },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Image override API base URL'), { target: { value: 'https://images.example.test/v1' } })
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'IMAGE_FIXTURE_KEY' } })
  const secret = screen.getByLabelText('Image API key')
  fireEvent.change(secret, { target: { value: 'preserved-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

  await waitFor(() => {
    expect(remote.mock.log.calls('settings/mutate')).toHaveLength(1)
    expect(remote.mock.log.calls('credentials/set')).toHaveLength(0)
  })
  expect(await screen.findByText('The deployment did not accept these values; they were left for you to correct.')).not.toBeNull()
  expect((secret as HTMLInputElement).value).toBe('preserved-secret')
})

it('keeps a secret draft when the credential store rejects it', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: { configuredCredentials: ['IMAGE_FIXTURE_KEY'], credentialsAccepted: false } },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'IMAGE_FIXTURE_KEY' } })
  await waitFor(() => {
    expect(screen.getByText('A key is configured.', { exact: true })).not.toBeNull()
  })
  const secret = screen.getByLabelText('Image API key')
  fireEvent.change(secret, { target: { value: 'rejected-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

  await waitFor(() => {
    expect(remote.mock.log.calls('settings/mutate')).toHaveLength(1)
    expect(remote.mock.log.calls('credentials/set')).toHaveLength(1)
  })
  expect(await screen.findByText('The deployment did not accept these values; they were left for you to correct.')).not.toBeNull()
  expect((secret as HTMLInputElement).value).toBe('rejected-secret')
})

it('marks a replacement credential status unknown when its read is rejected', async () => {
  mountAssembledApp({
    remote: {
      imageIterate: {
        configuredCredentials: ['OLD_IMAGE_FIXTURE_KEY'],
        rejectedCredentialDescriptions: ['NEW_IMAGE_FIXTURE_KEY'],
      },
    },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'OLD_IMAGE_FIXTURE_KEY' } })
  await waitFor(() => {
    expect(screen.getByText('A key is configured.', { exact: true })).not.toBeNull()
  })
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'NEW_IMAGE_FIXTURE_KEY' } })

  expect(await screen.findByText('Credential status is unavailable.', { exact: true })).not.toBeNull()
  expect(screen.queryByText('A key is configured.', { exact: true })).toBeNull()
})

it('clears a replacement credential while old and new status reads are pending', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: { configuredCredentials: ['OLD_IMAGE_FIXTURE_KEY'] } },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'OLD_IMAGE_FIXTURE_KEY' } })
  await waitFor(() => {
    expect(screen.getByText('A key is configured.', { exact: true })).not.toBeNull()
  })

  remote.holdCredentialDescription('OLD_IMAGE_FIXTURE_KEY')
  remote.holdCredentialDescription('NEW_IMAGE_FIXTURE_KEY')
  const oldSettlements = remote.credentialDescriptionSettlements('OLD_IMAGE_FIXTURE_KEY')
  const credentialDescriptionsBeforeRefresh = remote.mock.log.calls('credentials/describe').length
  remote.notifyCredentialReferenceUpdated('OLD_IMAGE_FIXTURE_KEY')
  await waitFor(() => {
    expect(remote.mock.log.calls('credentials/describe')).toHaveLength(credentialDescriptionsBeforeRefresh + 1)
  })
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'NEW_IMAGE_FIXTURE_KEY' } })
  await waitFor(() => {
    expect(remote.mock.log.calls('credentials/describe')).toHaveLength(credentialDescriptionsBeforeRefresh + 2)
  })

  expect(screen.getByText('Credential status is unavailable.', { exact: true })).not.toBeNull()
  expect(screen.queryByText('A key is configured.', { exact: true })).toBeNull()

  remote.releaseCredentialDescription('OLD_IMAGE_FIXTURE_KEY')
  await waitFor(() => {
    expect(remote.credentialDescriptionSettlements('OLD_IMAGE_FIXTURE_KEY')).toBe(oldSettlements + 1)
    expect(screen.getByText('Credential status is unavailable.', { exact: true })).not.toBeNull()
  })

  const newSettlements = remote.credentialDescriptionSettlements('NEW_IMAGE_FIXTURE_KEY')
  remote.releaseCredentialDescription('NEW_IMAGE_FIXTURE_KEY')
  await waitFor(() => {
    expect(remote.credentialDescriptionSettlements('NEW_IMAGE_FIXTURE_KEY')).toBe(newSettlements + 1)
    expect(screen.getAllByText('No key is configured.', { exact: true })).toHaveLength(2)
  })
})

it('disables both secret controls while a credential write is pending', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: { credentialSetDelayMs: 100 } },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Image override credential reference'), { target: { value: 'IMAGE_FIXTURE_KEY' } })
  const imageSecret = screen.getByLabelText('Image API key') as HTMLInputElement
  const reviewSecret = screen.getByLabelText('Review API key') as HTMLInputElement
  fireEvent.change(imageSecret, { target: { value: 'pending-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

  await waitFor(() => {
    expect(remote.mock.log.calls('credentials/set')).toHaveLength(1)
  })
  expect(imageSecret.disabled).toBe(true)
  expect(reviewSecret.disabled).toBe(true)
  await waitFor(() => {
    expect(screen.getByText('A key is configured.', { exact: true })).not.toBeNull()
  })
})

it('blocks invalid numeric settings before any remote write', async () => {
  const remote = mountAssembledApp({
    remote: { imageIterate: {} },
  })
  await openImageIterateSettings()
  fireEvent.change(screen.getByLabelText('Maximum iterations'), { target: { value: '4' } })

  expect(await screen.findByText('Enter an integer from 1 to 3.')).not.toBeNull()
  expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(remote.mock.log.calls('settings/mutate')).toHaveLength(0)
  expect(remote.mock.log.calls('credentials/set')).toHaveLength(0)
})

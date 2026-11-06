/**
 * RemoteMock scenario for built-client tests that do not own a Host.
 * The adjacent JSON is maintained with this module when Remote responses or
 * the current Session header version change.
 * Fixture Sessions have no retained Host terminals to restore.
 */

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'

interface SessionSummary {
  readonly sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: {
    readonly kind: 'cached' | 'sequenced'
    readonly asOfSeq: number
    readonly values: Readonly<Record<string, unknown>>
  }
}

interface WorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  sessionIds: string[]
  readonly createdAt: string
  updatedAt: string
}

export interface AssembledEventRecord {
  readonly type: 'event'
  readonly event: {
    readonly seq: number
    readonly time: number
    readonly type: string
    readonly data: unknown
    readonly surfaceOp?: string
  }
}

interface FollowSnapshot {
  readonly type: 'snapshot'
  readonly header: Readonly<Record<string, unknown>>
  readonly cursor: number
  readonly records: readonly AssembledEventRecord[]
  readonly hasMore: boolean
  readonly projections: Readonly<Record<string, unknown>>
  readonly assistantStream?: Readonly<Record<string, unknown>>
}

interface ControlBaseline {
  readonly type: 'baseline'
  readonly value: {
    readonly queues: Readonly<Record<string, readonly unknown[]>>
    readonly approvals: readonly unknown[]
    readonly questions: readonly unknown[]
    readonly projections: Readonly<Record<string, {
      readonly asOfSeq: number
      readonly values: Readonly<Record<string, unknown>>
    }>>
  }
}

interface CapturedFixture {
  readonly sessionList: { readonly ok: true; readonly value: { readonly items: readonly SessionSummary[] } }
  readonly settingsDescribe: {
    readonly ok: true
    readonly value: {
      readonly writable: boolean
      readonly hasDocument: boolean
      readonly namespaces: readonly unknown[]
    }
  }
  readonly credentialsDescribe: unknown
  readonly modelCatalog: unknown
  readonly agentPresets: unknown
  readonly commands: unknown
  readonly workspace: {
    readonly type: 'baseline'
    readonly value: {
      readonly items: readonly WorkspaceView[]
      readonly archivedSessionIds: readonly string[]
      readonly pinnedSessionIds: readonly string[]
    }
  }
  readonly control: ControlBaseline
  readonly remoteEvents: readonly unknown[]
  readonly follow: FollowSnapshot
  readonly attachment: unknown
}

/** Serialized `image-iterate-plugin` Config, as a Host settings document carries it. */
const imageIterateSchema = {
  uid: 22,
  refs: {
    1: { type: 'string', meta: { default: '' } },
    3: { type: 'string', meta: { default: '' } },
    5: { type: 'string', meta: { default: '' } },
    7: { type: 'string', meta: { default: '' } },
    9: { type: 'string', meta: { default: '' } },
    11: { type: 'string', meta: { default: '' } },
    13: { type: 'number', meta: { default: 2 } },
    15: { type: 'number', meta: { default: 120000 } },
    17: { type: 'string', meta: { default: '1024x1024' } },
    19: { type: 'string', meta: { default: 'medium' } },
    21: { type: 'string', meta: { default: 'png' } },
    22: {
      type: 'object',
      meta: { default: {} },
      dict: {
        imageBaseUrl: 1, imageModel: 3, imageCredential: 5,
        reviewBaseUrl: 7, reviewModel: 9, reviewCredential: 11,
        maxIterations: 13, timeoutMs: 15, defaultSize: 17,
        defaultQuality: 19, outputFormat: 21,
      },
    },
  },
} as const

export interface AssembledRemoteOptions {
  /** Override the schema-resolved Host preference for developer-tool scenarios. */
  readonly developerTools?: boolean
  /** Return the fixture's image-dimension admission error from Session prompt. */
  readonly rejectPrompt?: boolean
  /** Test-local attachment ids backed by an existing fixture attachment's bytes. */
  readonly attachmentAliases?: Readonly<Record<string, string>>
  /** Extra durable events appended to the fixture history Session before it is opened. */
  readonly alphaRecords?: readonly AssembledEventRecord[]
  /** Stateful image-review plugin settings and credentials for its assembled client test. */
  readonly imageIterate?: {
    /** Whether the fixture Host accepts settings-document writes. */
    readonly writable?: boolean
    /** Whether the fixture Host accepts otherwise writable settings mutations. */
    readonly mutationsAccepted?: boolean
    /** Whether the fixture credential provider accepts writes. */
    readonly credentialsWritable?: boolean
    /** Whether the fixture credential provider accepts otherwise writable replacements. */
    readonly credentialsAccepted?: boolean
    /** References the fixture reports as already configured. */
    readonly configuredCredentials?: readonly string[]
    /** References whose credential status reads the fixture rejects. */
    readonly rejectedCredentialDescriptions?: readonly string[]
    /** Delay a credential write so the assembled client can observe its saving state. */
    readonly credentialSetDelayMs?: number
  }
}

export interface AssembledRemote {
  readonly mock: RemoteMock
  /** Page-owned upload carrier: stages an image upload as the Host would and answers its receipt. */
  readonly fileUpload: (input: string | URL, init: RequestInit) => Promise<Response>
  /** Hold one image-iterate credential status read until the matching release call. */
  readonly holdCredentialDescription: (ref: string) => void
  /** Settle a held image-iterate credential status read. */
  readonly releaseCredentialDescription: (ref: string) => void
  /** Count completed image-iterate credential status reads for one reference. */
  readonly credentialDescriptionSettlements: (ref: string) => number
  /** Emit the Host invalidation for one image-iterate credential reference. */
  readonly notifyCredentialReferenceUpdated: (ref: string) => void
}

const fixtureSource = readFileSync(
  join(process.cwd(), 'apps/web/tests/fixtures/assembled-remote.fixture.json'),
  'utf8',
)

/** Create one isolated RemoteMock world for an assembled built-client case. */
export function createAssembledRemote(options: AssembledRemoteOptions = {}): AssembledRemote {
  const fixture = JSON.parse(fixtureSource) as CapturedFixture
  const sessions = [...structuredClone(fixture.sessionList.value.items)]
  const workspaces = [...structuredClone(fixture.workspace.value.items)]
  const alphaRecords = [
    ...(structuredClone(fixture.follow.records) as AssembledEventRecord[]),
    ...(options.alphaRecords === undefined ? [] : structuredClone(options.alphaRecords)),
  ]
  const records = new Map<string, AssembledEventRecord[]>([[
    'fx-alpha',
    alphaRecords,
  ]])
  const nextTurns = new Map([...records].map(([sessionId, sessionRecords]) => {
    let next = 0
    for (const { event } of sessionRecords) {
      if (event.type !== 'turn/start' || !isRecord(event.data)) continue
      const turn = event.data['turn']
      if (typeof turn === 'number') next = Math.max(next, turn + 1)
    }
    return [sessionId, next] as const
  }))
  const attachments = new Map<string, unknown>([['fixture:image', structuredClone(fixture.attachment)]])
  for (const [alias, source] of Object.entries(options.attachmentAliases ?? {})) {
    const stored = attachments.get(source)
    if (stored === undefined) throw new Error(`assembled fixture attachment alias source missing: ${source}`)
    attachments.set(alias, structuredClone(stored))
  }
  const stagedImages = new Map<string, Record<string, unknown>>()
  const blankSessionProjections = fixture.control.value.projections['fx-gamma']
  if (blankSessionProjections === undefined) {
    throw new Error('assembled fixture: blank Session projections missing')
  }
  let nextSession = 1
  const imageIterate = options.imageIterate === undefined
    ? undefined
    : {
      writable: options.imageIterate.writable ?? true,
      mutationsAccepted: options.imageIterate.mutationsAccepted ?? true,
      credentialsWritable: options.imageIterate.credentialsWritable ?? true,
      credentialsAccepted: options.imageIterate.credentialsAccepted ?? true,
      rejectedCredentialDescriptions: new Set(options.imageIterate.rejectedCredentialDescriptions ?? []),
      credentialSetDelayMs: options.imageIterate.credentialSetDelayMs ?? 0,
      revision: 0,
      base: {
        imageBaseUrl: '', imageModel: '', imageCredential: '',
        reviewBaseUrl: '', reviewModel: '', reviewCredential: '',
        maxIterations: 2, timeoutMs: 120000, defaultSize: '1024x1024', defaultQuality: 'medium', outputFormat: 'png',
      },
      user: {} as Record<string, unknown>,
      credentials: new Set(options.imageIterate.configuredCredentials ?? []),
    }
  const credentialDescriptionGates = new Map<string, PromiseWithResolvers<undefined>>()
  const credentialDescriptionSettled = new Map<string, number>()

  const requireImageIterate = () => {
    if (imageIterate === undefined) throw new Error('assembled fixture image credentials are not enabled')
    return imageIterate
  }

  const holdCredentialDescription = (ref: string) => {
    requireImageIterate()
    if (credentialDescriptionGates.has(ref)) throw new Error(`assembled fixture credential description is already held: ${ref}`)
    credentialDescriptionGates.set(ref, Promise.withResolvers<undefined>())
  }

  const releaseCredentialDescription = (ref: string) => {
    const gate = credentialDescriptionGates.get(ref)
    if (gate === undefined) throw new Error(`assembled fixture credential description is not held: ${ref}`)
    credentialDescriptionGates.delete(ref)
    gate.resolve(undefined)
  }

  const credentialDescriptionSettlements = (ref: string) => credentialDescriptionSettled.get(ref) ?? 0

  const notifyCredentialReferenceUpdated = (ref: string) => {
    requireImageIterate()
    mock.streams.push('$events', { type: 'emit', event: 'credentials/reference-updated', args: [ref] })
  }

  const imageIterateView = () => {
    if (imageIterate === undefined) return undefined
    return {
      ns: 'image-iterate-plugin',
      schema: imageIterateSchema,
      value: { ...imageIterate.base, ...imageIterate.user },
      base: imageIterate.base,
      ...Object.keys(imageIterate.user).length === 0 ? {} : { user: imageIterate.user },
      autoGenerate: false,
      applies: 'live',
      secrets: [],
      revision: imageIterate.revision,
    }
  }

  const settingsDescribe = () => ok({
    ...fixture.settingsDescribe.value,
    namespaces: [
      ...fixture.settingsDescribe.value.namespaces,
      {
        ns: 'ui-settings',
        schema: { type: 'object', dict: { enabled: { type: 'boolean' } } },
        value: { enabled: options.developerTools ?? true }, autoGenerate: false, applies: 'live', secrets: [], revision: 0,
      },
      ...(imageIterateView() === undefined ? [] : [imageIterateView()]),
    ],
  })

  const mock = RemoteMock.create().load(remoteDefaultResponses)
  mock.load({
    unary: {
      'session/modelCatalog': structuredClone(fixture.modelCatalog),
      'agentPresets/list': structuredClone(fixture.agentPresets),
      'commands/list': structuredClone(fixture.commands),
      'pluginInventory/list': ok({ entries: [], managementAvailable: true }),
      'pluginManager/listBundles': ok([]),
      'pluginManager/listPlugins': ok([]),
      'settings/openSettingsDocument': ok({ opened: true }),
      'subagents/list': ok({ entries: [], parentAvailable: true }),
      'terminal/list': ok([]),
      'skills/list': ok({ skills: [] }),
      'session/canOpenWorkspacePath': ok(true),
      'session/openWorkspacePath': ok({ opened: true }),
      'session/updateQueue': {
        ok: false,
        error: {
          code: 'session/queue-item-not-found',
          message: 'assembled fixture has no pending queue item',
          details: {},
        },
      },
      'session/cancel': ok({ accepted: true }),
    },
  })

  mock.unary('settings/describe', () => settingsDescribe())
  mock.unary('credentials/describe', (request: unknown) => {
    if (imageIterate === undefined) return structuredClone(fixture.credentialsDescribe)
    const refs = isRecord(request) ? request.refs : undefined
    if (!Array.isArray(refs)) throw new TypeError('assembled fixture credential references must be an array')
    const references = refs.map((ref) => {
      if (typeof ref !== 'string') throw new TypeError('assembled fixture credential reference must be a string')
      return ref
    })
    if (references.some(ref => imageIterate.rejectedCredentialDescriptions.has(ref))) {
      return rejected('credential/describe-rejected', 'assembled fixture did not return credential status')
    }
    const gates = references.flatMap((ref) => {
      const gate = credentialDescriptionGates.get(ref)
      return gate === undefined ? [] : [gate.promise]
    })
    const reply = () => ok(Object.fromEntries(references.map((ref) => {
      credentialDescriptionSettled.set(ref, credentialDescriptionSettlements(ref) + 1)
      return [ref, {
        configured: imageIterate.credentials.has(ref),
        writable: imageIterate.credentialsWritable,
      }]
    })))
    return gates.length === 0 ? reply() : Promise.all(gates).then(reply)
  })
  mock.unary('settings/mutate', (...args: unknown[]) => {
    if (imageIterate === undefined) throw new Error('assembled fixture image settings are not enabled')
    const request = args[0]
    const ns = isRecord(request) ? request.ns : undefined
    const ops = isRecord(request) ? request.ops : undefined
    const expectedRevision = isRecord(request) ? request.expectedRevision : undefined
    if (ns !== 'image-iterate-plugin' || !Array.isArray(ops) || typeof expectedRevision !== 'number') {
      throw new TypeError('assembled fixture image settings mutation is invalid')
    }
    if (!imageIterate.writable || !imageIterate.mutationsAccepted || expectedRevision !== imageIterate.revision) {
      return rejected('settings/rejected', 'assembled fixture did not accept the settings write')
    }
    for (const operation of ops) {
      if (!isRecord(operation) || !Array.isArray(operation.path) || operation.path.length !== 1 || typeof operation.path[0] !== 'string') {
        throw new TypeError('assembled fixture image settings operation is invalid')
      }
      const field = operation.path[0]
      if (operation.op === 'set') imageIterate.user[field] = operation.value
      else if (operation.op === 'unset') Reflect.deleteProperty(imageIterate.user, field)
      else throw new TypeError('assembled fixture image settings operation is unknown')
    }
    imageIterate.revision++
    const view = imageIterateView()
    if (view === undefined) throw new Error('assembled fixture image settings unexpectedly disappeared')
    mock.streams.push('$events', { type: 'emit', event: 'settings/document-updated', args: ['image-iterate-plugin', imageIterate.revision] })
    return ok(view)
  })
  mock.unary('credentials/set', async (request: unknown) => {
    if (imageIterate === undefined) throw new Error('assembled fixture image credentials are not enabled')
    const ref = isRecord(request) ? request.ref : undefined
    const value = isRecord(request) ? request.value : undefined
    if (typeof ref !== 'string' || typeof value !== 'string' || value.length === 0) {
      throw new TypeError('assembled fixture credential write is invalid')
    }
    if (!imageIterate.credentialsWritable || !imageIterate.credentialsAccepted) {
      return rejected('credential/rejected', 'assembled fixture did not accept the credential write')
    }
    if (imageIterate.credentialSetDelayMs > 0) await new Promise(resolve => setTimeout(resolve, imageIterate.credentialSetDelayMs))
    imageIterate.credentials.add(ref)
    mock.streams.push('$events', { type: 'emit', event: 'credentials/reference-updated', args: [ref] })
    return ok(undefined)
  })

  mock.stream('$events', (_args, stream) => {
    for (const frame of fixture.remoteEvents) stream.push(structuredClone(frame))
  })
  mock.stream('session/control', (_args, stream) => {
    stream.push(structuredClone(fixture.control))
  })
  mock.stream('job/list', (_args, stream) => {
    stream.push({ type: 'rows', jobs: [] })
  })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({
      type: 'baseline',
      value: {
        items: structuredClone(workspaces),
        archivedSessionIds: structuredClone(fixture.workspace.value.archivedSessionIds),
        pinnedSessionIds: structuredClone(fixture.workspace.value.pinnedSessionIds),
      },
    })
  })
  mock.stream('session/follow', ([args], stream) => {
    const request = recordValue(args, 'request')
    const sessionId = followedSessionId(request)
    if (sessionId === 'fx-alpha') {
      stream.push({
        ...structuredClone(fixture.follow),
        cursor: alphaRecords.at(-1)?.event.seq ?? fixture.follow.cursor,
        records: structuredClone(alphaRecords),
      })
      return
    }
    const summary = sessions.find(candidate => candidate.sessionId === sessionId)
    if (summary === undefined) throw new Error(`assembled fixture: no Session ${sessionId}`)
    const sessionRecords = records.get(sessionId) ?? []
    stream.push({
      type: 'snapshot',
      header: {
        version: 3,
        id: sessionId,
        createdAt: summary.updatedAt,
        cwd: summary.cwd,
        isSeeded: false,
      },
      cursor: sessionRecords.at(-1)?.event.seq ?? -1,
      records: structuredClone(sessionRecords),
      hasMore: false,
      projections: structuredClone(blankSessionProjections),
      ...isAssistantStreamRequested(request) ? { assistantStream: { revision: 0 } } : {},
    })
  })

  mock.unary('$events/result', (result: unknown) => {
    const eventId = recordString(result, 'eventId')
    mock.streams.push('$events', { type: 'cancel', eventId })
    return ok(undefined)
  })
  mock.unary('session/list', () => ok({ items: structuredClone(sessions) }))
  // The shipped composition mounts the `ui-schedule` row, so the Schedule
  // client reads the catalog over this mock.
  mock.unary('schedule/catalog', () => ok([]))
  mock.unary('session/projections', (request: unknown) => {
    const sessionId = recordString(recordValue(request, 'request'), 'sessionId')
    const summary = sessions.find(candidate => candidate.sessionId === sessionId)
    return ok(structuredClone(summary?.projections ?? fixture.control.value.projections[sessionId] ?? null))
  })
  mock.unary('workspace/create', (request: unknown) => {
    const path = recordString(recordValue(request, 'request'), 'path')
    const existing = workspaces.find(workspace => workspace.path === path)
    if (existing !== undefined) return ok({ workspace: structuredClone(existing), created: false })
    const now = new Date().toISOString()
    const workspace = {
      workspaceId: `fx-ws-${String(workspaces.length + 1)}`,
      path,
      title: path.split('/').filter(Boolean).at(-1) ?? path,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    workspaces.unshift(workspace)
    mock.streams.push('workspace/follow', { type: 'upsert', workspace: structuredClone(workspace) })
    return ok({ workspace: structuredClone(workspace), created: true })
  })
  mock.unary('session/create', (request: unknown) => {
    request = recordValue(request, 'request')
    const requestedId = optionalRecordString(request, 'sessionId')
    const sessionId = requestedId ?? `fx-${String(nextSession++)}`
    const existing = sessions.find(candidate => candidate.sessionId === sessionId)
    if (existing !== undefined) return ok({ sessionId })
    const workspaceId = optionalRecordString(request, 'workspaceId')
    const workspace = workspaces.find(candidate => candidate.workspaceId === workspaceId)
    const cwd = workspace?.path ?? optionalRecordString(request, 'cwd') ?? '/tmp/fixture'
    const summary: SessionSummary = {
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd,
      // The created Session is live on this fixture Host: its list block is
      // sequenced, like the block the real live registry would serve.
      projections: { kind: 'sequenced', ...structuredClone(blankSessionProjections) },
    }
    sessions.push(summary)
    records.set(sessionId, [])
    nextTurns.set(sessionId, 0)
    if (workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
      workspace.sessionIds = [sessionId, ...workspace.sessionIds]
      workspace.updatedAt = new Date().toISOString()
      mock.streams.push('workspace/follow', {
        type: 'upsert',
        workspace: structuredClone(workspace),
      })
    }
    mock.streams.push('$events', { type: 'emit', event: 'api-session/added', args: [structuredClone(summary)] })
    return ok({ sessionId })
  })
  mock.unary('session/attachment', (request: unknown) => {
    request = recordValue(request, 'request')
    const attachment = recordValue(request, 'attachment')
    const attachmentId = recordString(attachment, 'attachmentId')
    const stored = attachments.get(attachmentId)
    if (stored !== undefined) return ok({ attachment, data: recordString(recordValue(stored, 'value'), 'data') })
    return {
      ok: false,
      error: {
        code: 'session/attachment-invalid',
        message: `assembled fixture attachment ${attachmentId} is missing`,
        details: { reason: 'ATTACHMENT_NOT_FOUND' },
      },
    }
  })
  mock.unary('session/prompt', (request: unknown) => {
    request = recordValue(request, 'request')
    if (options.rejectPrompt === true) {
      return {
        ok: false,
        error: {
          code: 'session/attachment-invalid',
          message: 'assembled fixture: image side exceeds the deployment limit',
          details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
        },
      }
    }
    const sessionId = recordString(request, 'sessionId')
    const requestId = recordString(request, 'requestId')
    const sessionRecords = records.get(sessionId) ?? []
    const summary = sessions.find(candidate => candidate.sessionId === sessionId)
    if (summary === undefined) throw new Error(`assembled fixture: no Session ${sessionId}`)
    const content = recordArray(request, 'content').map((part) => {
      if (isRecord(part) && part.type === 'file') {
        const image = stagedImages.get(recordString(part, 'receiptId'))
        return image === undefined ? part : { type: 'image', attachment: image }
      }
      if (!isRecord(part) || part.type !== 'image') return part
      const attachmentId = `assembled:${randomUUID()}`
      const data = recordString(part, 'data')
      const attachment = {
        attachmentId,
        mediaType: recordString(part, 'mediaType'),
        bytes: Math.max(1, Math.floor(data.length * 3 / 4)),
        width: 160,
        height: 90,
        ...optionalRecordString(part, 'name') === undefined
          ? {}
          : { name: optionalRecordString(part, 'name') },
      }
      attachments.set(attachmentId, ok({ attachment, data }))
      return { type: 'image', attachment }
    })
    const turn = nextTurns.get(sessionId) ?? 0
    nextTurns.set(sessionId, turn + 1)
    summary.updatedAt = Date.now()
    summary.blank = false
    if (!summary.running) {
      summary.running = true
      mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [sessionId, true] })
    }
    const turnEvent = eventOf(sessionRecords.length, 'turn/start', { turn })
    const userEvent = eventOf(sessionRecords.length + 1, 'user/message', {
      content,
      source: { kind: 'user', rpcId: requestId },
      role: 'user',
      id: randomUUID(),
    }, 'append')
    sessionRecords.push(turnEvent, userEvent)
    records.set(sessionId, sessionRecords)
    mock.streams.push('session/follow', turnEvent, follows(sessionId))
    mock.streams.push('session/follow', userEvent, follows(sessionId))
    return ok({ accepted: true })
  })
  mock.unary('commands/execute', (args: unknown) => {
    const line = optionalRecordString(args, 'line') ?? ''
    const name = /^\/(\S+)/u.exec(line.trim())?.[1]
    if (name === undefined || !['compact', 'echo', 'goal', 'permission', 'plan'].includes(name)) {
      return ok(undefined)
    }
    return ok({
      commandId: `assembled-command-${randomUUID()}`,
      result: {
        kind: 'success',
        ...name === 'echo' ? { text: line.replace(/^\/echo\s*/u, '') } : {},
      },
    })
  })

  const fileUpload = async (input: string | URL, init: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://assembled.test/')
    const mediaType = url.searchParams.get('mediaType')
    if (!url.pathname.endsWith('/api/session/uploadFileBinary') || mediaType === null || !(init.body instanceof Blob)) {
      throw new Error(`assembled fixture: unexpected upload ${url.pathname}${url.search}`)
    }
    const bytes = new Uint8Array(await init.body.arrayBuffer())
    const name = url.searchParams.get('name')
    const image = {
      attachmentId: `assembled:${randomUUID()}`,
      mediaType,
      bytes: bytes.byteLength,
      width: 160,
      height: 90,
      ...name === null ? {} : { name },
    }
    attachments.set(image.attachmentId, ok({ attachment: image, data: Buffer.from(bytes).toString('base64') }))
    const receiptId = `assembled-receipt:${randomUUID()}`
    stagedImages.set(receiptId, image)
    return new Response(JSON.stringify({ ok: true, value: { receiptId, image } }), { status: 200 })
  }
  return {
    mock, fileUpload, holdCredentialDescription, releaseCredentialDescription,
    credentialDescriptionSettlements, notifyCredentialReferenceUpdated,
  }
}

function eventOf(
  seq: number,
  type: string,
  data: unknown,
  surfaceOp?: string,
): AssembledEventRecord {
  return {
    type: 'event',
    event: {
      seq,
      time: Date.now(),
      type,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    },
  }
}

function follows(sessionId: string): (args: readonly unknown[]) => boolean {
  return ([args]) => followedSessionId(recordValue(args, 'request')) === sessionId
}

function followedSessionId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.address)) throw new TypeError('assembled fixture follow request is invalid')
  return value.address.kind === 'session'
    ? recordString(value.address, 'sessionId')
    : recordString(value.address, 'childSessionId')
}

function isAssistantStreamRequested(value: unknown): boolean {
  return isRecord(value) && value.assistantStream === true
}

function recordString(value: unknown, key: string): string {
  const selected = isRecord(value) ? value[key] : undefined
  if (typeof selected !== 'string') throw new TypeError(`assembled fixture ${key} must be a string`)
  return selected
}

function optionalRecordString(value: unknown, key: string): string | undefined {
  const selected = isRecord(value) ? value[key] : undefined
  if (selected === undefined) return undefined
  if (typeof selected !== 'string') throw new TypeError(`assembled fixture ${key} must be a string`)
  return selected
}

function recordArray(value: unknown, key: string): readonly unknown[] {
  const selected = isRecord(value) ? value[key] : undefined
  if (!Array.isArray(selected)) throw new TypeError(`assembled fixture ${key} must be an array`)
  return selected
}

/** Return the gateway-style refusal a client settings form expects from one rejected write. */
function rejected(code: string, message: string): {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details: Record<string, never>
  }
} {
  return { ok: false, error: { code, message, details: {} } }
}

function recordValue(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) throw new TypeError(`assembled fixture ${key} is missing`)
  return value[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

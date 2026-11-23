/** Persistent, declarative enterprise capability ZIP runtime. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import yauzl from 'yauzl'

/** Public manifest accepted from a second-level enterprise ZIP. */
export interface RuntimeManifest {
  readonly id: string
  readonly version: string
  readonly runtimeApi: '1'
  readonly dependencies: readonly string[]
  readonly permissions: readonly string[]
  readonly entry: string
}

/** Optional, independently-owned read-only data source capability. */
export interface DataSourceApiV1 {
  readonly apiVersion: '1'
  execute(
    request: Readonly<{ query: JsonValue; cursor?: string; limit: number }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ rows: readonly JsonValue[]; nextCursor?: string }>>
}

/** Declarative screen templates accepted from a second-level enterprise ZIP. */
export interface ListTemplate extends Record<string, JsonValue> {
  readonly kind: 'list'
  readonly title: string
  readonly dataAction?: 'query'
  readonly query?: JsonValue
}

export interface DetailTemplate extends Record<string, JsonValue> {
  readonly kind: 'detail'
  readonly title: string
  readonly fields: string[]
  readonly dataAction?: 'query'
  readonly query?: JsonValue
}

export interface ChartTemplate extends Record<string, JsonValue> {
  readonly kind: 'chart'
  readonly title: string
  readonly chart: 'bar' | 'line' | 'pie'
  readonly x: string
  readonly y: string
  readonly dataAction?: 'query'
  readonly query?: JsonValue
}

export interface ReportTemplate extends Record<string, JsonValue> {
  readonly kind: 'report'
  readonly title: string
  readonly sections: string[]
  readonly dataAction?: 'query'
  readonly query?: JsonValue
}

export type RuntimeTemplate = ListTemplate | DetailTemplate | ChartTemplate | ReportTemplate

/** Stable facade for first-level Plugin Manager, Host, and client integrations. */
export interface EnterpriseRuntimeApiV1 {
  readonly apiVersion: '1'
  /** Install a trusted first-level ZIP through the service's validated, atomic pipeline. */
  install(zip: Uint8Array): Promise<RuntimeManifest>
  list(): readonly RuntimeManifest[]
  activate(id: string, version: string): void
  uninstall(id: string): Promise<void>
  invoke(id: string, signal: AbortSignal): Promise<RuntimeResult | RuntimeError>
}

/** JSON-safe output returned by an active enterprise capability. */
export interface RuntimeResult extends Record<string, JsonValue> {
  readonly template: RuntimeTemplate
  readonly rows?: JsonValue[]
  readonly nextCursor?: string
}

interface StoredPackage { manifest: RuntimeManifest; entry: RuntimeTemplate }
interface Inventory { packages: Record<string, Record<string, StoredPackage>> }
interface ActiveCapability { version: string; toolName: string; dispose: () => void }

/** A rejected archive, activation, or invocation. */
export class RuntimeError extends Error {}

/** Runtime service configuration. */
export interface Config {
  storageDir: string
  maxZipBytes?: number
  maxFiles?: number
  maxUnpackedBytes?: number
}

/** Convert a package identity to its stable model-facing tool name. */
export function capabilityToolName(id: string, version: string): string {
  return `enterprise_runtime_${Buffer.from(`${id}@${version}`).toString('hex')}`
}

/**
 * Owns durable declarative package payloads and their real Cordis tool registrations.
 * ZIP content never receives this Context or the optional data-source provider.
 */
export class EnterpriseRuntimeService extends Service {
  static inject = ['tools']
  static Config: z<Config> = z.object({
    storageDir: z.string(),
    maxZipBytes: z.number().default(5 * 1024 * 1024),
    maxFiles: z.number().default(32),
    maxUnpackedBytes: z.number().default(10 * 1024 * 1024),
  })

  private readonly root: string
  private readonly limits: Required<Omit<Config, 'storageDir'>>
  private inventory: Inventory = { packages: {} }
  private readonly active = new Map<string, ActiveCapability>()
  /** Public v1 facade for trusted first-level integrations; ZIP content and static client slots never receive it. */
  readonly api: EnterpriseRuntimeApiV1 = {
    apiVersion: '1',
    install: zip => this.install(zip),
    list: () => this.list(),
    activate: (id, version) => this.activate(id, version),
    uninstall: id => this.uninstall(id),
    invoke: (id, signal) => this.invoke(id, signal),
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'enterpriseRuntime')
    this.root = resolve(config.storageDir)
    this.limits = {
      maxZipBytes: config.maxZipBytes ?? 5 * 1024 * 1024,
      maxFiles: config.maxFiles ?? 32,
      maxUnpackedBytes: config.maxUnpackedBytes ?? 10 * 1024 * 1024,
    }
    ctx.effect(() => () => {
      for (const active of this.active.values()) active.dispose()
      this.active.clear()
    }, 'enterprise-runtime: deactivate packages')
  }

  /** Reload durable package metadata; capabilities deliberately stay inactive after restart. */
  async load(): Promise<void> {
    try {
      this.inventory = JSON.parse(await readFile(join(this.root, 'inventory.json'), 'utf8')) as Inventory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(this.root, { recursive: true })
    }
  }

  /** Validate, stage, atomically publish, then inventory one ZIP payload. */
  async install(zip: Uint8Array): Promise<RuntimeManifest> {
    if (zip.byteLength > this.limits.maxZipBytes) throw new RuntimeError('zip-too-large')
    const files = await readZip(zip, this.limits)
    const manifest = parseManifest(files.get('manifest.json'))
    const entry = parseEntry(files.get(manifest.entry))
    const existing = this.inventory.packages[manifest.id]
    if (existing?.[manifest.version] !== undefined) throw new RuntimeError('duplicate-package-version')

    const destination = packageDirectory(this.root, manifest)
    const staging = join(this.root, `.staging-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      for (const [name, data] of files) {
        const path = safeDestination(staging, name)
        await mkdir(resolve(path, '..'), { recursive: true })
        await writeFile(path, data)
      }
      await mkdir(resolve(destination, '..'), { recursive: true })
      await rename(staging, destination)
      const versions = { ...existing, [manifest.version]: { manifest, entry } }
      this.inventory = {
        packages: { ...this.inventory.packages, [manifest.id]: versions },
      }
      try {
        await this.save()
      } catch (error) {
        this.inventory = existing === undefined
          ? { packages: withoutKey(this.inventory.packages, manifest.id) }
          : { packages: { ...this.inventory.packages, [manifest.id]: existing } }
        await rm(destination, { recursive: true, force: true })
        throw error
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    return manifest
  }

  /**
   * Register the new capability before withdrawing the previous one.
   * A registration failure leaves the old model-facing tool and payload unchanged.
   */
  activate(id: string, version: string): void {
    this.package(id, version)
    const next = this.register(id, version)
    const previous = this.active.get(id)
    this.active.set(id, next)
    previous?.dispose()
  }

  /** Withdraw an active tool and remove every durable version of this package. */
  async uninstall(id: string): Promise<void> {
    this.active.get(id)?.dispose()
    this.active.delete(id)
    this.inventory = { packages: withoutKey(this.inventory.packages, id) }
    await rm(resolve(this.root, id), { recursive: true, force: true })
    await this.save()
  }

  /** List every installed package version, whether active or inactive. */
  list(): readonly RuntimeManifest[] {
    return Object.values(this.inventory.packages).flatMap(versions => Object.values(versions).map(item => item.manifest))
  }

  /** Execute through the public facade; provider objects never leave this service. */
  async invoke(id: string, signal: AbortSignal): Promise<RuntimeResult | RuntimeError> {
    const active = this.active.get(id)
    if (active === undefined) return new RuntimeError('capability-inactive')
    const item = this.package(id, active.version)
    if (item.entry.dataAction !== 'query') return { template: item.entry }
    const source = this.ctx.get('dataSourceApi')
    if (source === undefined || source.apiVersion !== '1') return new RuntimeError('data-source-unavailable')
    const result = await source.execute({ query: item.entry.query ?? { template: item.entry.title }, limit: 100 }, signal)
    return { template: item.entry, rows: [...result.rows], ...result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor } }
  }

  private register(id: string, version: string): ActiveCapability {
    const toolName = capabilityToolName(id, version)
    const dispose = this.ctx.tools.register(defineTool({
      name: toolName,
      description: `Run the active declarative enterprise capability ${id}.`,
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => {
        const result = await this.invoke(id, exec.signal)
        if (result instanceof RuntimeError) throw result
        return result
      },
    }))
    return { version, toolName, dispose }
  }

  private package(id: string, version: string): StoredPackage {
    const item = this.inventory.packages[id]?.[version]
    if (item === undefined) throw new RuntimeError('package-not-installed')
    return item
  }

  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temp = join(this.root, '.inventory.next.json')
    await writeFile(temp, JSON.stringify(this.inventory), 'utf8')
    await rename(temp, join(this.root, 'inventory.json'))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    enterpriseRuntime: EnterpriseRuntimeService
    dataSourceApi?: DataSourceApiV1
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}

function packageDirectory(root: string, manifest: RuntimeManifest): string {
  return safeDestination(root, `${manifest.id}/${manifest.version}`)
}

function safeDestination(root: string, name: string): string {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new RuntimeError('unsafe-path')
  const path = resolve(root, name)
  if (relative(root, path).startsWith('..')) throw new RuntimeError('unsafe-path')
  return path
}

function parseManifest(raw: Uint8Array | undefined): RuntimeManifest {
  if (raw === undefined) throw new RuntimeError('manifest-missing')
  const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>
  for (const key of ['id', 'version', 'runtimeApi', 'dependencies', 'permissions', 'entry']) {
    if (!(key in value)) throw new RuntimeError(`manifest-missing-${key}`)
  }
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(value.id)
    || typeof value.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value.version)) throw new RuntimeError('manifest-identity-invalid')
  if (value.runtimeApi !== '1') throw new RuntimeError('runtime-api-mismatch')
  if (!Array.isArray(value.dependencies) || !value.dependencies.every(item => typeof item === 'string')
    || !Array.isArray(value.permissions) || !value.permissions.every(item => item === 'data.read')) throw new RuntimeError('manifest-policy-invalid')
  if (typeof value.entry !== 'string' || value.entry.includes('..') || value.entry.includes('\\')) throw new RuntimeError('manifest-entry-invalid')
  return value as unknown as RuntimeManifest
}

function parseEntry(raw: Uint8Array | undefined): RuntimeTemplate {
  if (raw === undefined) throw new RuntimeError('entry-missing')
  const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>
  const dataAction: 'query' | undefined = value.dataAction === 'query' ? 'query' : undefined
  if (typeof value.title !== 'string' || (value.dataAction !== undefined && dataAction === undefined)) throw new RuntimeError('template-invalid')
  const action = dataAction === undefined ? {} : { dataAction }
  const query = value.query === undefined ? {} : { query: value.query as JsonValue }
  const base = { title: value.title, ...action, ...query }
  if (value.kind === 'list') return { kind: 'list', ...base }
  if (value.kind === 'detail' && Array.isArray(value.fields) && value.fields.every(field => typeof field === 'string')) {
    return { kind: 'detail', ...base, fields: value.fields }
  }
  if (value.kind === 'chart' && (value.chart === 'bar' || value.chart === 'line' || value.chart === 'pie')
    && typeof value.x === 'string' && typeof value.y === 'string') {
    return { kind: 'chart', ...base, chart: value.chart, x: value.x, y: value.y }
  }
  if (value.kind === 'report' && Array.isArray(value.sections) && value.sections.every(section => typeof section === 'string')) {
    return { kind: 'report', ...base, sections: value.sections }
  }
  throw new RuntimeError('template-invalid')
}

function readZip(zip: Uint8Array, limits: Required<Omit<Config, 'storageDir'>>): Promise<Map<string, Uint8Array>> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(
      Buffer.from(zip),
      { lazyEntries: true, validateEntrySizes: true },
      (openError, archive) => {
        if (openError !== null || archive === undefined) {
          const code = openError?.message.includes('relative path') ? 'unsafe-path' : 'zip-invalid'
          reject(new RuntimeError(code))
          return
        }
        const files = new Map<string, Uint8Array>()
        let total = 0
        let count = 0
        archive.on('entry', (entry) => {
          try {
            safeDestination('/', entry.fileName)
            if (files.has(entry.fileName)) throw new RuntimeError('duplicate-zip-member')
            if (++count > limits.maxFiles || (total += entry.uncompressedSize) > limits.maxUnpackedBytes) {
              throw new RuntimeError('zip-limits-exceeded')
            }
            archive.openReadStream(entry, (streamError, stream) => {
              if (streamError !== null || stream === undefined) {
                archive.close()
                reject(streamError)
                return
              }
              const chunks: Buffer[] = []
              stream.on('data', chunk => chunks.push(chunk))
              stream.on('end', () => {
                files.set(entry.fileName, Buffer.concat(chunks))
                archive.readEntry()
              })
              stream.on('error', (error) => {
                archive.close()
                reject(error)
              })
            })
          } catch (error) {
            archive.close()
            reject(error)
          }
        })
        archive.on('end', () => resolvePromise(files))
        archive.on('error', (error) => {
          const code = error.message.includes('relative path') ? 'unsafe-path' : 'zip-invalid'
          reject(new RuntimeError(code))
        })
        archive.readEntry()
      },
    )
  })
}

/** Persistent, declarative enterprise capability ZIP runtime. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import yauzl from 'yauzl'

export interface RuntimeManifest {
  readonly id: string
  readonly version: string
  readonly runtimeApi: '1'
  readonly dependencies: readonly string[]
  readonly permissions: readonly string[]
  readonly entry: string
}

export interface DataSourceApiV1 {
  readonly apiVersion: '1'
  execute(request: Readonly<{ query: unknown; cursor?: string; limit: number }>, signal: AbortSignal): Promise<Readonly<{ rows: readonly unknown[]; nextCursor?: string }>>
}

export interface ListTemplate {
  readonly kind: 'list'
  readonly title: string
  readonly dataAction?: 'query'
}

interface StoredPackage { manifest: RuntimeManifest; entry: ListTemplate }
interface Inventory { packages: Record<string, Record<string, StoredPackage>> }

export class RuntimeError extends Error {}

/** Runtime service configuration. */
export interface Config { storageDir: string; maxZipBytes?: number; maxFiles?: number; maxUnpackedBytes?: number }

/** Service owning durable package payloads and active declarative capability registrations. */
export class EnterpriseRuntimeService extends Service {
  static Config: z<Config> = z.object({
    storageDir: z.string(), maxZipBytes: z.number().default(5 * 1024 * 1024),
    maxFiles: z.number().default(32), maxUnpackedBytes: z.number().default(10 * 1024 * 1024),
  })

  private readonly root: string
  private readonly limits: Required<Omit<Config, 'storageDir'>>
  private inventory: Inventory = { packages: {} }
  private readonly active = new Map<string, () => void>()
  private readonly activeVersions = new Map<string, string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'enterpriseRuntime')
    this.root = resolve(config.storageDir)
    this.limits = { maxZipBytes: config.maxZipBytes ?? 5 * 1024 * 1024, maxFiles: config.maxFiles ?? 32, maxUnpackedBytes: config.maxUnpackedBytes ?? 10 * 1024 * 1024 }
    ctx.effect(() => async () => { for (const dispose of this.active.values()) dispose(); this.active.clear() }, 'enterprise-runtime: deactivate packages')
  }

  /** Reload persisted metadata; active capabilities deliberately remain inactive after process restart. */
  async load(): Promise<void> {
    try { this.inventory = JSON.parse(await readFile(join(this.root, 'inventory.json'), 'utf8')) as Inventory }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(this.root, { recursive: true }) }
  }

  /** Validate and persist a ZIP before publishing it in the inventory. */
  async install(zip: Uint8Array): Promise<RuntimeManifest> {
    if (zip.byteLength > this.limits.maxZipBytes) throw new RuntimeError('zip-too-large')
    const files = await readZip(zip, this.limits)
    const manifest = parseManifest(files.get('manifest.json'))
    const entry = parseEntry(files.get(manifest.entry))
    const versions = this.inventory.packages[manifest.id] ?? {}
    if (versions[manifest.version] !== undefined) throw new RuntimeError('duplicate-package-version')
    const destination = packageDirectory(this.root, manifest)
    await mkdir(destination, { recursive: true })
    try {
      for (const [name, data] of files) {
        const path = safeDestination(destination, name)
        await mkdir(resolve(path, '..'), { recursive: true })
        await writeFile(path, data)
      }
      versions[manifest.version] = { manifest, entry }
      this.inventory.packages[manifest.id] = versions
      await this.save()
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
    return manifest
  }

  /** Register a declarative list capability; replace only after the candidate registers successfully. */
  activate(id: string, version: string): void {
    const stored = this.package(id, version)
    const key = `${id}@${version}`
    const next = this.register(key, stored.entry)
    const previous = this.active.get(id)
    this.active.set(id, next)
    this.activeVersions.set(id, version)
    previous?.()
  }

  /** Remove the active registration and all persisted versions of one package. */
  async uninstall(id: string): Promise<void> {
    this.active.get(id)?.()
    this.active.delete(id)
    this.activeVersions.delete(id)
    delete this.inventory.packages[id]
    await rm(resolve(this.root, id), { recursive: true, force: true })
    await this.save()
  }

  list(): readonly RuntimeManifest[] { return Object.values(this.inventory.packages).flatMap(versions => Object.values(versions).map(item => item.manifest)) }

  /** Invoke the one POC facade operation. Data actions refuse while the optional provider seam is absent. */
  invoke(id: string): ListTemplate | RuntimeError {
    const active = this.active.has(id)
    if (!active) return new RuntimeError('capability-inactive')
    const version = this.activeVersions.get(id)
    const item = version === undefined ? undefined : this.inventory.packages[id]?.[version]
    if (item?.entry.dataAction === 'query') return new RuntimeError('data-source-unavailable')
    return item?.entry ?? new RuntimeError('capability-inactive')
  }

  private register(_key: string, entry: ListTemplate): () => void {
    if (entry.kind !== 'list') throw new RuntimeError('unsupported-template')
    return () => undefined
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

declare module '@deepseek-ai/cordis' { interface Context { enterpriseRuntime: EnterpriseRuntimeService } }

function packageDirectory(root: string, manifest: RuntimeManifest): string { return safeDestination(root, `${manifest.id}/${manifest.version}`) }
function safeDestination(root: string, name: string): string {
  if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new RuntimeError('unsafe-path')
  const path = resolve(root, name)
  if (relative(root, path).startsWith('..')) throw new RuntimeError('unsafe-path')
  return path
}
function parseManifest(raw: Uint8Array | undefined): RuntimeManifest {
  if (raw === undefined) throw new RuntimeError('manifest-missing')
  const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>
  for (const key of ['id', 'version', 'runtimeApi', 'dependencies', 'permissions', 'entry']) if (!(key in value)) throw new RuntimeError(`manifest-missing-${key}`)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(value.id) || typeof value.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value.version)) throw new RuntimeError('manifest-identity-invalid')
  if (value.runtimeApi !== '1') throw new RuntimeError('runtime-api-mismatch')
  if (!Array.isArray(value.dependencies) || !value.dependencies.every(x => typeof x === 'string') || !Array.isArray(value.permissions) || !value.permissions.every(x => x === 'data.read')) throw new RuntimeError('manifest-policy-invalid')
  if (typeof value.entry !== 'string' || value.entry.includes('..') || value.entry.includes('\\')) throw new RuntimeError('manifest-entry-invalid')
  return value as unknown as RuntimeManifest
}
function parseEntry(raw: Uint8Array | undefined): ListTemplate {
  if (raw === undefined) throw new RuntimeError('entry-missing')
  const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>
  if (value.kind !== 'list' || typeof value.title !== 'string' || (value.dataAction !== undefined && value.dataAction !== 'query')) throw new RuntimeError('template-invalid')
  return value as ListTemplate
}
function readZip(zip: Uint8Array, limits: Required<Omit<Config, 'storageDir'>>): Promise<Map<string, Uint8Array>> {
  return new Promise((resolvePromise, reject) => yauzl.fromBuffer(Buffer.from(zip), { lazyEntries: true, validateEntrySizes: true }, (openError, archive) => {
    if (openError || archive === undefined) { reject(openError ?? new RuntimeError('zip-invalid')); return }
    const files = new Map<string, Uint8Array>(); let total = 0; let count = 0
    archive.on('entry', entry => {
      try { safeDestination('/', entry.fileName); if (++count > limits.maxFiles || (total += entry.uncompressedSize) > limits.maxUnpackedBytes) throw new RuntimeError('zip-limits-exceeded')
        archive.openReadStream(entry, (streamError, stream) => { if (streamError || stream === undefined) { reject(streamError); return }; const chunks: Buffer[] = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); archive.readEntry() }); stream.on('error', reject) })
      } catch (error) { archive.close(); reject(error) }
    }); archive.on('end', () => resolvePromise(files)); archive.on('error', reject); archive.readEntry()
  }))
}

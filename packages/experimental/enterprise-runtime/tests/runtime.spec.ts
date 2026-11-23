import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnterpriseRuntimeService, RuntimeError } from '../src/index.ts'

let ctx: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  ctx = undefined
  directory = undefined
})

async function runtime(): Promise<EnterpriseRuntimeService> {
  directory = await mkdtemp(join(tmpdir(), 'enterprise-runtime-'))
  ctx = new Context()
  await ctx.plugin(EnterpriseRuntimeService, { storageDir: directory })
  await ctx.enterpriseRuntime.load()
  return ctx.enterpriseRuntime
}

async function fixture(name: string): Promise<Uint8Array> {
  return await readFile(new URL(`./fixtures/${name}`, import.meta.url))
}

describe('enterprise runtime', () => {
  it('mounts in Cordis, persists inventory and replaces an active declaration', async () => {
    const service = await runtime()
    await service.install(await fixture('basic.zip'))
    service.activate('acme.orders', '1.0.0')
    expect(service.invoke('acme.orders')).toEqual({ kind: 'list', title: 'Orders' })
    await service.install(await fixture('update.zip'))
    service.activate('acme.orders', '2.0.0')
    expect(service.invoke('acme.orders')).toEqual({ kind: 'list', title: 'Orders v2' })

    await ctx!.fiber.dispose()
    ctx = new Context()
    await ctx.plugin(EnterpriseRuntimeService, { storageDir: directory! })
    await ctx.enterpriseRuntime.load()
    expect(ctx.enterpriseRuntime.list()).toHaveLength(2)
  })

  it('rejects traversal, duplicate versions and invalid candidate updates without replacing the active declaration', async () => {
    const service = await runtime()
    await expect(service.install(await fixture('traversal.zip'))).rejects.toThrow('unsafe-path')
    await service.install(await fixture('basic.zip'))
    await expect(service.install(await fixture('basic.zip'))).rejects.toThrow('duplicate-package-version')
    service.activate('acme.orders', '1.0.0')
    await expect(service.install(await fixture('bad-update.zip'))).rejects.toThrow('template-invalid')
    expect(service.invoke('acme.orders')).toEqual({ kind: 'list', title: 'Orders' })
  })

  it('keeps installation metadata available when an optional data source is absent', async () => {
    const service = await runtime()
    await service.install(await fixture('basic.zip'))
    service.activate('acme.orders', '1.0.0')
    expect(service.list()[0]?.id).toBe('acme.orders')
    expect(service.invoke('missing')).toBeInstanceOf(RuntimeError)
    await service.uninstall('acme.orders')
    expect(service.list()).toEqual([])
  })
})

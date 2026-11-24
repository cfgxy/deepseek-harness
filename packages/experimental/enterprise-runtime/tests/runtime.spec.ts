import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilityToolName, EnterpriseRuntimeService, type DataSourceApiV1, RuntimeError } from '../src/index.ts'

let ctx: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  ctx = undefined
  directory = undefined
})

async function runtime(source?: DataSourceApiV1): Promise<EnterpriseRuntimeService> {
  directory = await mkdtemp(join(tmpdir(), 'enterprise-runtime-'))
  ctx = new Context()
  if (source !== undefined) ctx.provide('dataSourceApi', source)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(EnterpriseRuntimeService, { storageDir: directory })
  await ctx.enterpriseRuntime.load()
  return ctx.enterpriseRuntime
}

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url))
}

describe('enterprise runtime', () => {
  it('installs through the v1 facade, mounts real tools, swaps active registrations, and restores inactive inventory', async () => {
    const service = await runtime()
    await service.api.install(await fixture('basic.zip'))
    expect(service.api.list()).toHaveLength(1)
    service.api.activate('acme.orders', '1.0.0')
    const firstTool = capabilityToolName('acme.orders', '1.0.0')
    const registered = ctx!.tools.get(firstTool)
    expect(registered).toBeDefined()
    await expect(registered!.execute({}, { signal: new AbortController().signal } as never)).resolves.toEqual({ template: { kind: 'list', title: 'Orders' } })
    expect(await service.api.invoke('acme.orders', new AbortController().signal)).toEqual({ template: { kind: 'list', title: 'Orders' } })

    await service.api.install(await fixture('update.zip'))
    service.api.activate('acme.orders', '2.0.0')
    const secondTool = capabilityToolName('acme.orders', '2.0.0')
    expect(ctx!.tools.get(firstTool)).toBeUndefined()
    expect(ctx!.tools.get(secondTool)).toBeDefined()
    expect(await service.api.invoke('acme.orders', new AbortController().signal)).toEqual({ template: { kind: 'list', title: 'Orders v2' } })

    await ctx!.fiber.dispose()
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(EnterpriseRuntimeService, { storageDir: directory! })
    await ctx.enterpriseRuntime.load()
    expect(ctx.enterpriseRuntime.api.list()).toHaveLength(2)
    expect(await ctx.enterpriseRuntime.api.invoke('acme.orders', new AbortController().signal)).toBeInstanceOf(RuntimeError)
  })

  it('preserves the old active tool when facade activation of the new registration fails', async () => {
    const service = await runtime()
    await service.api.install(await fixture('basic.zip'))
    await service.api.install(await fixture('update.zip'))
    service.api.activate('acme.orders', '1.0.0')
    const candidate = capabilityToolName('acme.orders', '2.0.0')
    ctx!.tools.register(defineTool({
      name: candidate,
      description: 'intentional collision',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'collision' },
    }))
    expect(() => service.api.activate('acme.orders', '2.0.0')).toThrow()
    expect(ctx!.tools.get(capabilityToolName('acme.orders', '1.0.0'))).toBeDefined()
    expect(await service.api.invoke('acme.orders', new AbortController().signal)).toEqual({ template: { kind: 'list', title: 'Orders' } })
  })

  it('keeps facade validation failures and rollbacks from publishing payloads', async () => {
    const service = await runtime()
    await expect(service.api.install(await fixture('traversal.zip'))).rejects.toThrow('unsafe-path')
    await service.api.install(await fixture('basic.zip'))
    await expect(service.api.install(await fixture('basic.zip'))).rejects.toThrow('duplicate-package-version')
    await expect(service.api.install(await fixture('bad-update.zip'))).rejects.toThrow('template-invalid')
    expect(service.api.list()).toHaveLength(1)
  })

  it('supports declarative details, charts, reports, and a connector-free Langfuse question', async () => {
    const observed: JsonValue[] = []
    const source: DataSourceApiV1 = {
      apiVersion: '1',
      async execute(request) {
        observed.push(request.query)
        return { rows: [{ value: 12 }] }
      },
    }
    const service = await runtime(source)
    for (const name of ['detail.zip', 'chart.zip', 'langfuse-report.zip']) await service.api.install(await fixture(name))
    for (const [id, version] of [['acme.order-detail', '1.0.0'], ['acme.order-chart', '1.0.0'], ['acme.langfuse-question', '1.0.0']] as const) {
      service.api.activate(id, version)
    }
    await expect(service.api.invoke('acme.order-detail', new AbortController().signal)).resolves.toMatchObject({
      template: { kind: 'detail', fields: ['id', 'status'] }, rows: [{ value: 12 }],
    })
    await expect(service.api.invoke('acme.order-chart', new AbortController().signal)).resolves.toMatchObject({
      template: { kind: 'chart', chart: 'bar', x: 'status', y: 'count' },
    })
    await expect(service.api.invoke('acme.langfuse-question', new AbortController().signal)).resolves.toMatchObject({
      template: { kind: 'report', title: 'Langfuse trace volume' },
    })
    expect(observed).toContainEqual({ source: 'langfuse', question: 'How many traces were recorded in the selected period?' })
  })

  it('reports an absent data source and projects only rows from an optional provider', async () => {
    const missing = await runtime()
    await missing.api.install(await fixture('query.zip'))
    missing.api.activate('acme.query-orders', '1.0.0')
    await expect(missing.api.invoke('acme.query-orders', new AbortController().signal)).resolves.toMatchObject({ message: 'data-source-unavailable' })
    await ctx!.fiber.dispose()

    const source: DataSourceApiV1 = {
      apiVersion: '1',
      async execute() { return { rows: [{ id: 'o-1' }] } },
    }
    const service = await runtime(source)
    await service.api.install(await fixture('query.zip'))
    service.api.activate('acme.query-orders', '1.0.0')
    expect(await service.api.invoke('acme.query-orders', new AbortController().signal)).toEqual({
      template: { kind: 'list', title: 'Query orders', dataAction: 'query' }, rows: [{ id: 'o-1' }],
    })
  })
})

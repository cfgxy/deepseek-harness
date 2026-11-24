// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { EnterpriseRuntimePrototype } from '../src/client/EnterpriseRuntimePrototype.tsx'
import { NS, apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

function subject(name: string): PluginsSubject {
  return {
    kind: 'bundle',
    pkg: { name, installed: true, availability: 'profile', official: false, enabled: true, rows: [] },
  }
}

it('registers the Plugin Manager detail slot and renders only the enterprise runtime bundle', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.detail.section': { kind: 'list', scope: 'root' } } } as never, () => null)

  await ctx.plugin({ inject, apply }).await()
  const [entry] = slots.entries('plugins.detail.section')
  expect(entry?.options.id).toBe('enterprise-runtime.prototype')
  expect(entry?.locale).toBe(NS)
  expect(locale.bind(NS)('heading')).toBe('Enterprise capability prototypes')

  const t = locale.bind(NS)
  const Component = entry!.component as typeof EnterpriseRuntimePrototype
  const target = render(<Component subject={subject('@deepseek-ai/dsh-experimental-enterprise-runtime-bundle')} t={t} />)
  expect(screen.getByRole('heading', { name: 'Enterprise capability prototypes' })).toBeTruthy()
  expect(screen.getByText('List: a queryable collection.')).toBeTruthy()
  target.unmount()

  const other = render(<Component subject={subject('@deepseek-ai/dsh-other-bundle')} t={t} />)
  expect(other.container.innerHTML).toBe('')
})

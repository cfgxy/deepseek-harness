// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import {
  installAssembledBootEnv, mountAssembledApp, unmountAssembledApp,
  type AdditionalAssembledPlugin,
} from './assembled-boot.ts'

installAssembledBootEnv()

interface ClientManifest {
  readonly name?: unknown
  readonly exports?: { readonly './client'?: unknown }
  readonly dsh?: { readonly client?: { readonly platform?: unknown; readonly inject?: unknown } }
}

const manifestPath = resolve(import.meta.dirname, '../../../packages/bundle/data-sources/package.json')

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function dataSourcesPlugin(): AdditionalAssembledPlugin {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientManifest
  const client = manifest.exports?.['./client']
  const output = typeof client === 'string' ? client : record(client)?.default
  const declaration = manifest.dsh?.client
  if (typeof manifest.name !== 'string' || typeof output !== 'string' || declaration?.platform !== 'web'
    || !Array.isArray(declaration.inject) || !declaration.inject.every(item => typeof item === 'string')) {
    throw new Error('data-sources client manifest is incomplete')
  }
  return {
    id: manifest.name,
    bundlePath: resolve(dirname(manifestPath), output),
    url: `plugins/${manifest.name}/client.js`,
    rev: 'fixture-data-sources',
    inject: declaration.inject,
  }
}

function input(name: string): HTMLInputElement {
  const value = document.getElementById(`plugin-config-data-sources-${name}`)
  if (!(value instanceof HTMLInputElement)) throw new Error(`data-sources input missing: ${name}`)
  return value
}

async function openDataSourcesSettings(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Plugins$/ }))
  const card = await waitFor(() => {
    const value = document.querySelector<HTMLElement>('[data-plugin-item="data-sources"]')
    if (value === null) throw new Error('data-sources card missing')
    return value
  })
  fireEvent.click(within(card).getByRole('button', { name: /^View Data sources$/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
  await waitFor(() => { input('credential-reference') }, { timeout: 1_000 }).catch(() => {
    const section = document.querySelector('section[aria-label]')
    throw new Error(`data-sources editor did not become ready: ${section?.textContent ?? 'section missing'}`)
  })
}

it('renders and saves the assembled source editor with only a credential reference', async () => {
  const remote = mountAssembledApp({
    additionalPlugins: [dataSourcesPlugin()],
    remote: {
      dataSources: {},
    },
  })

  await openDataSourcesSettings()
  fireEvent.change(input('credential-reference'), { target: { value: 'DB_READONLY' } })
  expect(input('credential-reference').value).toBe('DB_READONLY')
  expect(screen.getByRole('button', { name: /test/i })).not.toBeNull()
  const text = document.body.textContent ?? ''
  expect(text).toContain('Credentials are referenced by name')

  fireEvent.change(input('label'), { target: { value: 'Renamed fixture' } })
  const form = input('label').closest('form')
  if (form === null) throw new Error('data-sources form missing')
  fireEvent.submit(form)
  await waitFor(() => { expect(remote.mock.log.calls('settings/mutate')).toHaveLength(2) })
  const writes = JSON.stringify(remote.mock.log.calls('settings/mutate'))
  expect(writes).toContain('Renamed fixture')
  expect(writes).not.toContain('rejectUnauthorized')
  expect(writes).toContain('DB_READONLY')

  await unmountAssembledApp()
  expect(document.querySelector('[data-plugin-item="data-sources"]')).toBeNull()
})

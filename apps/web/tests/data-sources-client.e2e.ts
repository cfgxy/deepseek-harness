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
  return { id: manifest.name, bundlePath: resolve(dirname(manifestPath), output), url: `plugins/${manifest.name}/client.js`, rev: 'fixture-data-sources', inject: declaration.inject }
}

function input(name: string): HTMLInputElement {
  const value = document.getElementById(`plugin-config-data-sources-${name}`)
  if (!(value instanceof HTMLInputElement)) throw new Error(`data-sources input missing: ${name}`)
  return value
}

function select(name: string): HTMLSelectElement {
  const value = document.getElementById(`plugin-config-data-sources-${name}`)
  if (!(value instanceof HTMLSelectElement)) throw new Error(`data-sources select missing: ${name}`)
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
}

function fillPostgresDraft(): void {
  fireEvent.change(select('kind'), { target: { value: 'postgresql' } })
  fireEvent.change(input('label'), { target: { value: 'Analytics database' } })
  fireEvent.change(input('host'), { target: { value: 'db.example.test' } })
  fireEvent.change(input('database'), { target: { value: 'analytics' } })
  fireEvent.change(input('credential-reference'), { target: { value: 'DB_READONLY' } })
}

it('keeps a new source local until save and persists a TLS allowlist only', async () => {
  const remote = mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: {} } })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
  expect(remote.mock.log.calls('settings/mutate')).toHaveLength(0)
  fillPostgresDraft()
  fireEvent.click(screen.getByText('Advanced settings'))
  fireEvent.click(screen.getByRole('switch', { name: 'Enable TLS' }))
  fireEvent.change(input('tls-ca-path'), { target: { value: '/etc/ssl/ca.pem' } })
  fireEvent.change(input('tls-server-name'), { target: { value: 'db.example.test' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Test connection' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => { expect(remote.mock.log.calls('settings/mutate')).toHaveLength(1) })
  const writes = JSON.stringify(remote.mock.log.calls('settings/mutate'))
  expect(writes).toContain('Analytics database')
  expect(writes).toContain('DB_READONLY')
  expect(writes).toContain('tls')
  expect(writes).not.toContain('password')
  expect(writes).not.toContain('secretAccessKey')
  await unmountAssembledApp()
})

it('probes only a saved source id and renders a safe result', async () => {
  const remote = mountAssembledApp({
    additionalPlugins: [dataSourcesPlugin()],
    remote: { dataSources: { probe: { ok: false, message: 'host secret must not render' }, sources: [{
      id: 'analytics', revision: '1', kind: 'postgresql', label: 'Analytics', enabled: true, credentialRef: 'DB_READONLY',
      connection: { host: 'db.example.test', database: 'analytics', tls: { enabled: true, caPath: '/etc/ssl/ca.pem' } }, policy: { maxBytes: 65536, maxRows: 100 },
    }] } },
  })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Connection test failed.') })
  expect(document.body.textContent).not.toContain('host secret must not render')
  expect(remote.mock.log.requests('dataSources/probe')).toEqual([{ request: { sourceId: 'analytics' } }])
  await unmountAssembledApp()
})

it('requires confirmation before replacing a dirty source editor', async () => {
  mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: { sources: [
    { id: 'analytics', revision: '1', kind: 'postgresql', label: 'Analytics', enabled: true, credentialRef: 'DB_READONLY', connection: { host: 'analytics.example.test', database: 'analytics' }, policy: { maxBytes: 65536, maxRows: 100 } },
    { id: 'archive', revision: '1', kind: 'mysql', label: 'Archive', enabled: true, credentialRef: 'ARCHIVE_READONLY', connection: { host: 'archive.example.test', database: 'archive' }, policy: { maxBytes: 65536, maxRows: 100 } },
  ] } } })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }))
  fireEvent.change(input('label'), { target: { value: 'Unsaved analytics' } })
  fireEvent.click(screen.getByRole('button', { name: /Archive/ }))
  expect(screen.getByText('Discard unsaved changes?')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(input('label').value).toBe('Unsaved analytics')
  expect(select('kind').value).toBe('postgresql')
  fireEvent.click(screen.getByRole('button', { name: /Archive/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => { expect(input('label').value).toBe('Archive') })
  expect(select('kind').value).toBe('mysql')
  await unmountAssembledApp()
})

it('requires confirmation before adding over a dirty draft', async () => {
  mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: { sources: [{
    id: 'analytics', revision: '1', kind: 'postgresql', label: 'Analytics', enabled: true, credentialRef: 'DB_READONLY', connection: { host: 'analytics.example.test', database: 'analytics' }, policy: { maxBytes: 65536, maxRows: 100 },
  }] } } })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }))
  fireEvent.change(input('label'), { target: { value: 'Unsaved analytics' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
  expect(screen.getByText('Discard unsaved changes?')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(input('label').value).toBe('Unsaved analytics')
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => { expect(select('kind').value).toBe('') })
  await unmountAssembledApp()
})

it('requires confirmation before changing the type of a dirty draft', async () => {
  mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: {} } })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
  fireEvent.change(select('kind'), { target: { value: 'postgresql' } })
  fireEvent.change(input('label'), { target: { value: 'Unsaved database' } })
  fireEvent.change(input('host'), { target: { value: 'db.example.test' } })
  fireEvent.change(select('kind'), { target: { value: 'sftp' } })
  expect(screen.getByText('Discard unsaved changes?')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(select('kind').value).toBe('postgresql')
  expect(input('host').value).toBe('db.example.test')
  fireEvent.change(select('kind'), { target: { value: 'sftp' } })
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => { expect(select('kind').value).toBe('sftp') })
  expect(input('host').value).toBe('')
  await unmountAssembledApp()
})

it('requires confirmation before removing a dirty source', async () => {
  mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: { sources: [{
    id: 'analytics', revision: '1', kind: 'postgresql', label: 'Analytics', enabled: true, credentialRef: 'DB_READONLY', connection: { host: 'analytics.example.test', database: 'analytics' }, policy: { maxBytes: 65536, maxRows: 100 },
  }] } } })
  await openDataSourcesSettings()
  fireEvent.click(screen.getByRole('button', { name: /Analytics/ }))
  fireEvent.change(input('label'), { target: { value: 'Unsaved analytics' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove source' }))
  expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(input('label').value).toBe('Unsaved analytics')
  expect(screen.queryByRole('dialog', { name: 'Remove data source?' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove source' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  const removeDialog = await screen.findByRole('dialog', { name: 'Remove data source?' })
  await waitFor(() => { expect(document.activeElement).toBe(within(removeDialog).getByRole('button', { name: 'Cancel' })) })
  fireEvent.click(within(removeDialog).getByRole('button', { name: 'Cancel' }))
  await unmountAssembledApp()
})

it('does not offer writes to a read-only settings document', async () => {
  const remote = mountAssembledApp({ additionalPlugins: [dataSourcesPlugin()], remote: { dataSources: { writable: false } } })
  await openDataSourcesSettings()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add source' }).disabled).toBe(true)
  expect(remote.mock.log.calls('settings/mutate')).toHaveLength(0)
  await unmountAssembledApp()
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('client registers a credential-safe settings page and releases every lifetime registration', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } }, structuredClone })
  assert.equal(registration.id, '@ruyi/dsh-data-sources')

  const React = { createElement(type, props, ...children) { return { type, props, children } }, useEffect() {}, useState(value) { return [value, () => {}] } }
  const jsxRuntime = { Fragment: 'Fragment', jsx(type, props) { return { type, props } }, jsxs(type, props) { return { type, props } } }
  const primitives = { Button() { return null }, Input() { return null } }
  const clientStore = { createSnapshotStore(value) { let snapshot = value; return { getSnapshot() { return snapshot }, subscribe() { return () => {} }, set(next) { snapshot = next } } } }
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (specifier === '@deepseek-ai/dsh-client-store') return clientStore
    throw new Error(`unexpected client dependency: ${specifier}`)
  })
  assert.deepEqual([...client.inject], ['slots', 'locale', 'remote', 'configForms'])

  let scopeDisposed = 0
  let localeDisposed = 0
  let slotDisposed = 0
  const writes = []
  const cleanups = []
  const registrations = []
  const scope = {
    getSnapshot() {
      return {
        status: 'ready', writable: true, value: {
          sources: [{
            id: 'fixture', revision: '1', kind: 'mysql', label: 'Fixture DB', credentialRef: 'DB_READONLY',
            connection: { host: 'db.fixture.test', password: 'must-not-render', tls: { rejectUnauthorized: true } },
            policy: { maxBytes: 1024, maxRows: 10 }, secret: 'must-not-render',
          }],
        },
      }
    },
    subscribe() { return () => { scopeDisposed += 1 } },
    async mutate(ops) { writes.push(ops); return true },
  }
  const ctx = {
    effect(callback) { cleanups.push(callback()) },
    locale: { register() { return () => { localeDisposed += 1 } }, bind() { return key => key } },
    remote: {},
    configForms: { get() { return scope }, whileServed(_names, register) { return register() } },
    slots: {
      inject(_name, callback) { return callback() },
      register(definition, component) { registrations.push({ definition, component }); return () => { slotDisposed += 1 } },
    },
  }
  client.apply(ctx)
  const page = registrations.find(entry => entry.definition.name === 'plugins.item')
  assert.notEqual(page, undefined)
  const face = page.definition.inject()
  const state = face.hooks.dataSourcesSettings.getSnapshot()
  const projection = JSON.stringify(state)
  assert.match(projection, /DB_READONLY/)
  assert.doesNotMatch(projection, /must-not-render/)
  assert.equal(typeof face.test, 'function')
  const rendered = page.component({
    view: 'detail', t: key => key, ...face,
    useDataSourcesSettings(select) { return select(state) },
  })
  assert.match(JSON.stringify(rendered), /credentialRef/)
  assert.doesNotMatch(JSON.stringify(rendered), /must-not-render/)
  face.save({ ...state.sources[0], label: 'Renamed fixture' })
  await new Promise(resolve => setImmediate(resolve))
  const saved = JSON.stringify(writes)
  assert.match(saved, /rejectUnauthorized/)
  assert.doesNotMatch(saved, /must-not-render/)
  face.test('fixture')
  assert.match(face.hooks.dataSourcesSettings.getSnapshot().probes.fixture.message, /unavailable/)

  for (const cleanup of cleanups.reverse()) cleanup?.()
  assert.equal(scopeDisposed, 1)
  assert.equal(localeDisposed, 1)
  assert.equal(slotDisposed, 1)
})

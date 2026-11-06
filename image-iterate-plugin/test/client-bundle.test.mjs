import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'

test('客户端产物以 Harness classic-script 工厂注册', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-image-iterate-plugin')
  assert.equal(typeof registration.factory, 'function')

  const React = {
    createElement(type, props, ...children) { return { type, props, children } },
  }
  const formState = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
  let modelDisposals = 0
  class SettingsFormModel {
    bind() { return { subscribe() { return () => {} } } }
    shell() { return formState }
    field(field) { return { text: field === 'imageCredential' ? 'PENDING_IMAGE_KEY' : '', overridden: false, invalid: false } }
    actions() { return { edit() {}, resetField() {}, discard() {} } }
    async save() {}
    dispose() { modelDisposals++ }
  }
  const storePublishes = []
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore(value) { return { set(next) { storePublishes.push(next) }, getSnapshot() { return value }, subscribe() { return () => {} } } } }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return { SettingsForm() {}, SettingsFormModel, SettingsSecretField() {}, SettingsValueField() {}, settingsNumberField(field) { return { field } }, settingsTextField(field) { return { field } } }
    }
    assert.fail(`unexpected module ${specifier}`)
  })
  assert.deepEqual([...client.inject], ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])

  const registrations = []
  const injections = []
  const localeRegistrations = []
  const remoteListeners = []
  let formStoreUnsubscribes = 0
  let scopeUnsubscribes = 0
  let resolveCredentialRead
  const pendingCredentialRead = new Promise(resolve => { resolveCredentialRead = resolve })
  const ctx = new Context()
  const locale = {
    bind() { return key => key },
    register(namespace) {
      localeRegistrations.push(namespace)
      return () => { localeRegistrations.splice(localeRegistrations.indexOf(namespace), 1) }
    },
  }
  const remote = {
    credentials: { async describe() { return pendingCredentialRead } },
    $on(event, listener) {
      remoteListeners.push({ event, listener })
      return () => { remoteListeners.splice(remoteListeners.findIndex(item => item.listener === listener), 1) }
    },
  }
  const configForms = {
    get() {
      return {
        getSnapshot() { return { status: 'ready', writable: true } },
        subscribe() { return () => { scopeUnsubscribes++ } },
        async mutate() { return true },
      }
    },
    whileServed(_names, callback) { return callback() },
  }
  const slots = {
    inject(name, callback) {
      injections.push(name)
      return callback()
    },
    register(definition, component) {
      const registration = { definition, component }
      registrations.push(registration)
      return () => { registrations.splice(registrations.indexOf(registration), 1) }
    },
  }
  ctx.provide('locale', locale)
  ctx.provide('remote', remote)
  ctx.provide('remote.credentials', remote.credentials)
  ctx.provide('configForms', configForms)
  ctx.provide('slots', slots)
  const originalBind = SettingsFormModel.prototype.bind
  SettingsFormModel.prototype.bind = function bind(project) {
    const store = originalBind.call(this, project)
    return { ...store, subscribe() { return () => { formStoreUnsubscribes++ } } }
  }
  const fiber = ctx.plugin(client)
  await fiber.await()
  assert.deepEqual(injections, ['plugins.item', 'tool.call.toolview', 'image-iterate.tool.call.images'])
  assert.equal(registrations[0].definition.name, 'plugins.item')
  assert.equal(registrations[0].definition.id, 'image-iterate-plugin')
  assert.equal(registrations[1].definition.name, 'tool.call.toolview')
  assert.equal(registrations[1].definition.key, 'generate_image_with_review')
  assert.equal(registrations[1].definition.children['image-iterate.tool.call.images'].kind, 'single')
  assert.equal(registrations[1].definition.children['image-iterate.tool.call.images'].scope, 'session')
  assert.equal(typeof registrations[1].component, 'function')

  const galleryCalls = []
  const attachment = {
    attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 12, width: 3, height: 4, name: 'image.png',
    originalDimensions: { width: 6, height: 8 },
  }
  registrations[1].component({
    phase: 'result',
    block: { isError: false, meta: { image: attachment }, content: [{ type: 'text', text: 'complete' }] },
    loadImage: 'gateway-authorized-loader',
    renderSlot(name, owner) {
      galleryCalls.push({ name, owner })
      return { gallery: true }
    },
  })
  assert.equal(galleryCalls.length, 1)
  assert.equal(galleryCalls[0].name, 'image-iterate.tool.call.images')
  assert.equal(galleryCalls[0].owner.loadImage, 'gateway-authorized-loader')
  assert.equal(galleryCalls[0].owner.align, 'start')
  assert.deepEqual(JSON.parse(JSON.stringify(galleryCalls[0].owner.images)), [{ attachment }])

  registrations[1].component({
    phase: 'result',
    block: {
      isError: false,
      meta: {
        image: {
          attachment_id: 'sha256:legacy-image',
          media_type: 'image/jpeg',
          bytes: 24,
          width: 6,
          height: 8,
          name: 'legacy-image.jpg',
        },
      },
      content: [],
    },
    loadImage: 'gateway-authorized-loader',
    renderSlot(name, owner) {
      galleryCalls.push({ name, owner })
      return { gallery: true }
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(galleryCalls[1].owner.images)), [{
    attachment: {
      attachmentId: 'sha256:legacy-image',
      mediaType: 'image/jpeg',
      bytes: 24,
      width: 6,
      height: 8,
      name: 'legacy-image.jpg',
    },
  }])

  assert.equal(registrations[2].definition.name, 'image-iterate.tool.call.images')
  assert.equal(registrations[2].definition.priority, 100)
  const factoryCalls = []
  registrations[2].component({
    ...galleryCalls[0].owner,
    renderFactorySlot(name, owner) {
      factoryCalls.push({ name, owner })
      return { gallery: true }
    },
  })
  assert.equal(factoryCalls[0].name, 'conversation.images.content')
  assert.deepEqual(JSON.parse(JSON.stringify(factoryCalls[0].owner)), JSON.parse(JSON.stringify(galleryCalls[0].owner)))

  await fiber.dispose()
  resolveCredentialRead({ ok: true, value: { PENDING_IMAGE_KEY: { configured: true, writable: true } } })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(localeRegistrations, [])
  assert.deepEqual(remoteListeners, [])
  assert.deepEqual(registrations, [])
  assert.equal(modelDisposals, 1)
  assert.equal(formStoreUnsubscribes, 1)
  assert.equal(scopeUnsubscribes, 1)
  assert.deepEqual(storePublishes, [])
})

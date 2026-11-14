import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('客户端产物以 Harness classic-script 工厂注册', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, '@deepseek-ai/dsh-image-iterate-plugin')
  assert.equal(typeof registration.factory, 'function')

  const React = {
    createElement(type, props, ...children) { return { type, props, children } },
  }
  const jsxRuntime = {
    Fragment: 'Fragment',
    jsx(type, props) { return { type, props, children: [] } },
    jsxs(type, props) { return { type, props, children: props?.children ?? [] } },
  }
  class SettingsFormModel {
    constructor(scope) { this.scope = scope }
    bind(project) {
      return { getSnapshot: project, subscribe() { return () => {} }, set() {} }
    }
    field() { return { text: '', overridden: false, invalid: false } }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  }
  const SettingsForm = () => null
  const SettingsSecretField = () => null
  const SettingsValueField = () => null
  const settingsField = field => ({ field })
  const clientUiPrimitives = {
    SettingsForm,
    SettingsSecretField,
    SettingsValueField,
    SettingsFormModel,
    settingsNumberField: settingsField,
    settingsTextField: settingsField,
  }
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return clientUiPrimitives
    throw new Error(`unexpected client dependency: ${specifier}`)
  })
  assert.deepEqual([...client.inject], ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])

  const registrations = []
  const injections = []
  const scope = {
    getSnapshot() {
      return { status: 'ready', value: {}, base: {}, user: {}, writable: true, revision: 1 }
    },
    subscribe() { return () => {} },
    async mutate() { return true },
  }
  const ctx = {
    effect(callback) { return callback() },
    locale: {
      register() { return () => {} },
      bind() { return key => key },
    },
    remote: {
      $on() { return () => {} },
      credentials: {
        async describe() { return { ok: true, value: {} } },
        async set() { return { ok: true } },
      },
    },
    configForms: {
      get() { return scope },
      whileServed(_names, register) { return register() },
    },
    slots: {
      inject(name, callback) {
        injections.push(name)
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(injections, ['plugins.item', 'tool.call.toolview'])
  const toolRegistration = registrations.find(({ definition }) => definition.name === 'tool.call.toolview')
  assert.notEqual(toolRegistration, undefined)
  assert.equal(toolRegistration.definition.key, 'generate_image_with_review')
  assert.equal('children' in toolRegistration.definition, false)
  assert.equal(typeof toolRegistration.component, 'function')

  const galleryCalls = []
  const attachment = {
    attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 12, width: 3, height: 4, name: 'image.png',
    originalDimensions: { width: 6, height: 8 },
  }
  toolRegistration.component({
    phase: 'result',
    block: { isError: false, meta: { image: attachment }, content: [{ type: 'text', text: 'complete' }] },
    loadImage: 'gateway-authorized-loader',
    renderFactorySlot(name, owner) {
      galleryCalls.push({ name, owner })
      return { gallery: true }
    },
  })
  assert.equal(galleryCalls.length, 1)
  assert.equal(galleryCalls[0].name, 'conversation.images.content')
  assert.equal(galleryCalls[0].owner.loadImage, 'gateway-authorized-loader')
  assert.equal(galleryCalls[0].owner.align, 'start')
  assert.deepEqual(JSON.parse(JSON.stringify(galleryCalls[0].owner.images)), [{ attachment }])

  toolRegistration.component({
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
    renderFactorySlot(name, owner) {
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
})

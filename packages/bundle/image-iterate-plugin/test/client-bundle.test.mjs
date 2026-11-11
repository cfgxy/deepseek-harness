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
  const client = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.deepEqual([...client.inject], ['slots'])

  const registrations = []
  const injections = []
  const ctx = {
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
  assert.deepEqual(injections, ['tool.call.toolview'])
  assert.equal(registrations[0].definition.name, 'tool.call.toolview')
  assert.equal(registrations[0].definition.key, 'generate_image_with_review')
  assert.equal('children' in registrations[0].definition, false)
  assert.equal(typeof registrations[0].component, 'function')

  const galleryCalls = []
  const attachment = {
    attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 12, width: 3, height: 4, name: 'image.png',
    originalDimensions: { width: 6, height: 8 },
  }
  registrations[0].component({
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

  registrations[0].component({
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

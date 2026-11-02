import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('客户端产物以 Harness classic-script 工厂注册', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-image-iterate-plugin')
  assert.equal(typeof registration.factory, 'function')

  const React = { createElement() {}, useEffect() {}, useState() { return [undefined, () => {}] } }
  const client = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.deepEqual([...client.inject], ['slots'])

  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) {
        assert.equal(name, 'tool.call.toolview')
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
      },
    },
  }
  client.apply(ctx)
  assert.equal(registrations[0].definition.name, 'tool.call.toolview')
  assert.equal(registrations[0].definition.key, 'generate_image_with_review')
  assert.equal(typeof registrations[0].component, 'function')
  assert.match(source, /图片附件暂时无法加载/)
})

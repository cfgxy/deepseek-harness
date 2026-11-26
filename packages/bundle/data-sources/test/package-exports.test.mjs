import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageUrl = new URL('../package.json', import.meta.url)
const remoteSpecifier = '@ruyi/dsh-data-sources/remote'
const hostSpecifier = '@ruyi/dsh-data-sources/typert'

test('publishes only the generated remote type boundary, not the internal api module', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.equal(Object.hasOwn(manifest.exports, './api'), false)
  assert.deepEqual(manifest.exports['./types'], { types: './lib/types/api.d.ts' })

  const remote = await import(remoteSpecifier)
  const host = await import(hostSpecifier)
  assert.equal(remote.default.package, '@ruyi/dsh-data-sources')
  assert.equal(host.TYPERT.package, '@ruyi/dsh-data-sources')

  const declaration = await readFile(new URL('../lib/typert.remote-client.d.ts', import.meta.url), 'utf8')
  assert.match(declaration, /from '@ruyi\/dsh-data-sources\/types'/)
  assert.doesNotMatch(declaration, /@ruyi\/dsh-data-sources\/api/)
})

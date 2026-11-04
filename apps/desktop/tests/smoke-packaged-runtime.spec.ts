import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePackagedRuntimeExecutable } from '../scripts/smoke-packaged-runtime.ts'

describe('packaged runtime smoke executable', () => {
  it('uses the hosted internal-test Windows executable name', () => {
    expect(resolvePackagedRuntimeExecutable('C:\\package\\win-unpacked', true, {
      DSH_DESKTOP_HOSTED_UNSIGNED: '1',
    })).toBe(join('C:\\package\\win-unpacked', 'DeepSeek Harness Internal Test.exe'))
  })

  it('uses the standard executable name for ordinary Windows packages', () => {
    expect(resolvePackagedRuntimeExecutable('C:\\package\\win-unpacked', true, {}))
      .toBe(join('C:\\package\\win-unpacked', 'DeepSeek Harness.exe'))
  })
})

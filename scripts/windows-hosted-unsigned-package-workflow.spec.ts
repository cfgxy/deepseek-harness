import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-package.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: string; required?: boolean; options?: string[] }> } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    'runs-on': string
    if?: string
    uses?: string
    with?: Record<string, string>
    env?: Record<string, string>
    steps: Array<{ id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }>
  }>
}
const reusable = yaml.load(readFileSync(resolve(root, '.github/workflows/windows-hosted-unsigned-package.yml'), 'utf8')) as {
  on: { workflow_call: { inputs: Record<string, { type?: string; default?: string; required?: boolean }> } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, {
    'runs-on': string
    env: Record<string, string>
    steps: Array<{ id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }>
  }>
}
const selfHosted = workflow.jobs.package!
const hosted = workflow.jobs['hosted-unsigned']!
const job = reusable.jobs.package!

it('uses the default-branch registered workflow as the dispatch entry without changing the self-hosted default', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch.inputs.package_mode).toMatchObject({
    type: 'choice', default: 'self-hosted-signed', options: ['self-hosted-signed', 'hosted-unsigned'],
  })
  expect(selfHosted).toMatchObject({ if: "inputs.package_mode == 'self-hosted-signed'", 'runs-on': 'dsh-win-package-trial' })
  expect(hosted).toMatchObject({
    if: "inputs.package_mode == 'hosted-unsigned'", uses: './.github/workflows/windows-hosted-unsigned-package.yml',
    with: { source_ref: '${{ inputs.source_ref }}', build_version: '${{ inputs.build_version }}', signing: '${{ inputs.signing }}' },
  })
})

it('runs the selected hosted path through a credential-free Windows reusable workflow', () => {
  expect(Object.keys(reusable.on)).toEqual(['workflow_call'])
  expect(Object.keys(reusable.on.workflow_call.inputs).sort()).toEqual(['build_version', 'signing', 'source_ref'])
  expect(job['runs-on']).toBe('windows-2025')
  expect(reusable.permissions).toEqual({ contents: 'read' })
  expect(reusable.concurrency).toEqual({ group: 'windows-hosted-unsigned-desktop-package', 'cancel-in-progress': false })
  expect(job.env).toEqual({ DSH_TELEMETRY_DISABLED: '1', PACKAGE_SOURCE_REF: '${{ inputs.source_ref }}' })
  expect(job.steps.find(step => step.name === 'Reject signing or publication requests')?.run).toContain("$env:PACKAGE_SIGNING -ne 'unsigned'")
  expect(job.steps.find(step => step.id === 'checkout')?.with).toEqual({
    'persist-credentials': false, ref: '${{ inputs.source_ref }}',
  })
})

it('runs the credential-free configuration check, complete package smoke, and 14-day unsigned artifact upload', () => {
  const commands = job.steps.filter(step => step.run?.includes('package:desktop:win:x64'))
  expect(commands).toHaveLength(2)
  expect(commands[0]!.run).toContain('--check --unsigned --hosted-unsigned')
  expect(commands[1]!.run).toContain('--unsigned --hosted-unsigned')
  for (const command of commands) expect(command.run).not.toContain('prepare-windows-ci.mjs')
  const installer = job.steps.find(step => step.name === 'Retain verified unsigned installer')!
  expect(installer.if).toBe('success()')
  expect(installer.uses).toBe('actions/upload-artifact@v7.0.1')
  expect(installer.with).toMatchObject({
    'compression-level': 0,
    path: '${{ steps.installer.outputs.path }}',
    'if-no-files-found': 'error',
    'retention-days': 14,
  })
  const proof = job.steps.find(step => step.id === 'installer')!
  expect(proof.run).toContain('Expected exactly one unsigned installer')
  expect(proof.run).toContain('Get-FileHash')
  const serialized = JSON.stringify(reusable)
  for (const forbidden of ['DSH_PACKAGING_PRESET', 'DSH_PACKAGING_CONFIG_DIR', 'DSH_DESKTOP_MANDATORY_UPDATE_',
    'DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
    'DSH_DESKTOP_WINDOWS_SIGNTOOL', 'CSC_', 'DOWNLOAD_', 'desktop-publish']) {
    expect(serialized).not.toContain(forbidden)
  }
})

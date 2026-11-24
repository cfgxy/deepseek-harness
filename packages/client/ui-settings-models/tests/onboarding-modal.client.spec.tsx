// @vitest-environment jsdom
/** Shared onboarding chrome must remain a painted, scrollable surface in headless Modal mode. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'
import css from '../src/client/OnboardingModal.module.css'

const sheet = readFileSync(resolve(process.cwd(), 'packages/client/ui-settings-models/src/client/OnboardingModal.module.css'), 'utf8')
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(sheet)
  if (match === null) throw new Error(`OnboardingModal.module.css has no ${selector} rule`)
  return match[1] ?? ''
}

afterEach(cleanup)

describe('OnboardingModal visual surface', () => {
  it('keeps headless content inside shared dialog and does not add default close chrome', () => {
    render(<OnboardingModal title="Shared onboarding"><p>Step body</p></OnboardingModal>)
    const dialog = screen.getByRole('dialog', { name: 'Shared onboarding' })
    expect(dialog.classList.contains(css.dialog ?? '')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Shared onboarding' }).parentElement?.classList.contains(css.content ?? '')).toBe(true)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('paints an opaque themed surface with a bounded scroll region', () => {
    const dialog = block('.dialog')
    const content = block('.content')
    expect(dialog).toContain('max-height: min(720px, 100%)')
    expect(content).toContain('max-height: 100%')
    expect(content).toContain('overflow-y: auto')
    expect(content).toContain('border: 0.5px solid var(--dsw-alias-border-l3)')
    expect(content).toContain('border-radius: var(--dsw-radius-panel)')
    expect(content).toContain('background: var(--dsw-alias-bg-layer-2)')
    expect(content).toContain('box-shadow: var(--dsw-elevation-prominent)')
  })
})

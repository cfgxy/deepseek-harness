// Real Web composition for the Enterprise Runtime bundle: the profile installs
// the first-level bundle, and Chromium verifies its detail-slot contribution
// without exposing second-level ZIPs or Host APIs to the browser.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-experimental-enterprise-runtime-bundle'
const BUNDLE_DIR = fileURLToPath(new URL('../../../packages/experimental/enterprise-runtime-bundle', import.meta.url))
const RUNTIME_DIR = fileURLToPath(new URL('../../../packages/experimental/enterprise-runtime', import.meta.url))
const CLIENT_DIR = fileURLToPath(new URL('../../../packages/experimental/client-ui-enterprise-runtime', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/enterprise-runtime-plugin-manager', import.meta.url))
const DETAIL_EXPECTED = join(SNAPSHOT_DIR, 'detail.expected.md')
const MODE = webSnapshotMode()

/** Open the real Plugin Manager panel from the assembled Web shell. */
async function openPlugins(page: Page) {
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.getByRole('heading', { name: 'Plugins', exact: true }).waitFor({ timeout: 15_000 })
  return panel
}

describe('web e2e: Enterprise Runtime Plugin Manager contribution', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      // A real profile resolves the bundle's Host and Web package closure at
      // its root; only the bundle itself is selected as an active bundle.
      profile: {
        packages: [
          { dir: BUNDLE_DIR, enabled: true },
          { dir: RUNTIME_DIR },
          { dir: CLIENT_DIR },
        ],
      },
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'enterprise-runtime')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders localized declarative capability information only for the Enterprise Runtime bundle', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-enterprise-runtime-plugin-manager'))
    const panel = await openPlugins(page)
    const target = panel.locator(`[data-plugin-package="${BUNDLE}"]`)
    await target.waitFor({ timeout: 15_000 })
    await target.getByRole('button').first().click()

    const detail = panel.locator(`[data-plugin-detail="${BUNDLE}"]`)
    const prototype = detail.locator('[data-enterprise-runtime-prototype]')
    await prototype.waitFor({ timeout: 15_000 })
    await prototype.getByRole('heading', { name: 'Enterprise capability prototypes', exact: true }).waitFor()
    for (const copy of [
      'List: a queryable collection.',
      'Detail: selected fields for one record.',
      'Chart: bar, line, or pie data projection.',
      'Report: ordered JSON-safe sections.',
    ]) await prototype.getByText(copy, { exact: true }).waitFor()

    await compareOrRefreshGolden(DETAIL_EXPECTED,
      await captureStableAria(page, `[data-plugin-detail="${BUNDLE}"]`, scaffold.workspaceCwd, {
        replacements: [[BUNDLE_DIR, '{{bundle}}']],
      }), MODE)

    await panel.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    const nonTarget = panel.locator(`[data-plugin-package]:not([data-plugin-package="${BUNDLE}"])`).first()
    await nonTarget.waitFor({ timeout: 15_000 })
    await nonTarget.getByRole('button').first().click()
    await panel.locator('[data-plugin-detail]').waitFor({ timeout: 15_000 })
    expect(await panel.locator('[data-enterprise-runtime-prototype]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the Enterprise Runtime detail fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['detail.expected.md'])
  })
})

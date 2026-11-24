import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import enterpriseRuntimeRemote from '@deepseek-ai/dsh-experimental-enterprise-runtime/remote'
import type {} from '@deepseek-ai/dsh-experimental-enterprise-runtime/remote'
import { createElement } from 'react'
import { IconAppsAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnterpriseAppsPanel } from './EnterpriseAppsPanel.tsx'
import { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

const PANEL_ID = 'self-growing-engine' as MainPanelId

function EnterpriseAppsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return createElement(IconAppsAddOutlineRegular, { size })
}

export { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'
export { EnterpriseAppsPanel } from './EnterpriseAppsPanel.tsx'
export { NS, type EnterpriseRuntimeLocaleKey } from './locales.ts'

/** Services required to register the user plaza, Plugin Manager detail contribution, and dictionaries. */
export const inject = ['slots', 'locale', 'remote']

/** Register the user-facing enterprise application plaza backed by a read-only Host projection. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(enterpriseRuntimeRemote)
  const ui = ctx.inject(['remote.enterpriseRuntime', 'slots', 'locale'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-enterprise-runtime: dictionaries')
    const t = scope.locale.bind(NS)
    scope.slots.inject('plugins.detail.section', () => scope.slots.register({
      name: 'plugins.detail.section', id: 'enterprise-runtime.prototype', order: 100, locale: NS,
    }, EnterpriseRuntimePrototype))
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: PANEL_ID, locale: NS,
      inject: () => ({ loadApps: () => scope.remote.enterpriseRuntime.apps() }),
    }, EnterpriseAppsPanel))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => t('panel'), locale: NS,
    }, EnterpriseAppsIcon))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}

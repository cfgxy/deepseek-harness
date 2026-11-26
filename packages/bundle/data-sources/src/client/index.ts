/** Browser-side Plugins settings contribution for read-only data sources. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@ruyi/dsh-data-sources/remote'
import remote from '@ruyi/dsh-data-sources/remote'
import { DataSourcesCard } from './DataSourcesCard.tsx'
import { DataSourcesPage } from './DataSourcesPage.tsx'
import { DataSourcesPanelIcon } from './DataSourcesPanelIcon.tsx'
import { en, zh, type DataSourcesLocaleKey } from './locales.ts'
import { DATA_SOURCES_NS, DataSourcesSettingsController } from './settings-controller.ts'

export type { DataSourcesCardProps } from './DataSourcesCard.tsx'
export type { DataSourcesPageProps } from './DataSourcesPage.tsx'
export type { DataSourceDraft, DataSourcesCardFace, DataSourcesCardState, SourceKind } from './settings-controller.ts'

export const NS = 'settings.dataSources'
export const DATA_SOURCES_PANEL_ID = 'data-sources' as MainPanelId
export const inject = ['slots', 'locale', 'remote', 'configForms']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.dataSources': DataSourcesLocaleKey }
}

/** Register the source list and editor only for Hosts serving the data-sources namespace. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.dataSources'], (remoteCtx) => {
    remoteCtx.effect(() => remoteCtx.locale.register(NS, { en, zh }), 'data-sources: dictionaries')
    const card = new DataSourcesSettingsController(remoteCtx.configForms.get(DATA_SOURCES_NS), remoteCtx)
    remoteCtx.effect(() => () => { card.dispose() }, 'data-sources: settings subscription')
    const t = remoteCtx.locale.bind(NS)
    remoteCtx.effect(() => remoteCtx.configForms.whileServed([DATA_SOURCES_NS], () => {
      const disposePluginsItem = remoteCtx.slots.inject('plugins.item', () => remoteCtx.slots.register({
        name: 'plugins.item', id: 'data-sources', order: 32, label: () => t('title'), locale: NS, inject: () => card.inject(),
      }, DataSourcesCard))
      const disposeSidebar = remoteCtx.slots.inject('sidebar.panellist', () => remoteCtx.slots.register({
        name: 'sidebar.panellist', id: DATA_SOURCES_PANEL_ID, order: 20, label: () => t('panel'), locale: NS,
      }, DataSourcesPanelIcon))
      const disposeMain = remoteCtx.slots.inject('main', () => remoteCtx.slots.register({
        name: 'main', key: DATA_SOURCES_PANEL_ID, locale: NS, inject: () => card.inject(),
      }, DataSourcesPage))
      return () => {
        disposePluginsItem()
        disposeSidebar()
        disposeMain()
      }
    }), 'data-sources: plugin settings page and sidebar panel')
  })
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}

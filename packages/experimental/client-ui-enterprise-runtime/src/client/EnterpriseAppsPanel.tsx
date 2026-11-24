import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RuntimeAppView } from '@deepseek-ai/dsh-experimental-enterprise-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export interface EnterpriseAppsPanelProps extends PropsLocale<'enterpriseRuntime'> {
  readonly loadApps: () => Promise<RemoteResult<readonly RuntimeAppView[]>>
}

function PageDemo({ app, t }: { app: RuntimeAppView; t: EnterpriseAppsPanelProps['t'] }): ReactNode {
  const { page } = app
  if (page.kind === 'list') return <section data-enterprise-runtime-demo="list">
    <h2>{page.title}</h2><p>{t('demo.list')}</p><div className="enterpriseRuntimeList">{t('demo.listResult')}</div>
  </section>
  if (page.kind === 'detail') return <section data-enterprise-runtime-demo="detail">
    <h2>{page.title}</h2><p>{t('demo.detail')}</p><dl>{page.fields?.map(field => <div key={field}><dt>{field}</dt><dd>{t('demo.value')}</dd></div>)}</dl>
  </section>
  if (page.kind === 'chart') return <section data-enterprise-runtime-demo="chart">
    <h2>{page.title}</h2><p>{t('demo.chart', { chart: page.chart ?? 'bar', x: page.x ?? '', y: page.y ?? '' })}</p>
    <div role="img" aria-label={t('demo.chartResult')} className="enterpriseRuntimeChart"><i /><i /><i /></div>
  </section>
  return <section data-enterprise-runtime-demo="report">
    <h2>{page.title}</h2><p>{t('demo.report')}</p>
    {app.question !== undefined && <p data-enterprise-runtime-question>{app.question}</p>}
    <ol>{page.sections?.map(section => <li key={section}>{section}</li>)}</ol>
  </section>
}

/** User-facing application plaza backed only by the Host's read-only app projection. */
export function EnterpriseAppsPanel({ loadApps, t }: EnterpriseAppsPanelProps): ReactNode {
  const [apps, setApps] = useState<readonly RuntimeAppView[] | undefined>()
  const [selected, setSelected] = useState<RuntimeAppView | undefined>()
  useEffect(() => { void loadApps().then(result => setApps(result.ok ? result.value : []), () => setApps([])) }, [loadApps])
  if (apps === undefined) return <main data-enterprise-runtime-plaza aria-busy="true" />
  if (selected !== undefined) return <main data-enterprise-runtime-app>
    <button type="button" onClick={() => setSelected(undefined)}>{t('back')}</button>
    <header><span aria-hidden="true">{selected.app.icon}</span><div><p>{selected.app.category}</p><h1>{selected.app.name}</h1><p>{selected.app.description}</p></div></header>
    <PageDemo app={selected} t={t} />
  </main>
  if (apps.length === 0) return <main data-enterprise-runtime-plaza><h1>{t('panel')}</h1><p data-enterprise-runtime-empty>{t('empty')}</p></main>
  const categories = new Map<string, RuntimeAppView[]>()
  for (const app of apps) categories.set(app.app.category, [...categories.get(app.app.category) ?? [], app])
  return <main data-enterprise-runtime-plaza>
    <header><h1>{t('panel')}</h1><p>{t('introPlaza')}</p></header>
    {[...categories].map(([category, rows]) => <section key={category} data-enterprise-runtime-category={category}>
      <h2>{category}</h2><div className="enterpriseRuntimeGrid">{rows.map(app => <button type="button" key={`${app.id}@${app.version}`} className="enterpriseRuntimeCard" onClick={() => setSelected(app)}>
        <span aria-hidden="true" className="enterpriseRuntimeIcon">{app.app.icon}</span><strong>{app.app.name}</strong><small>{app.app.description}</small><em>{app.app.category}</em>
      </button>)}</div>
    </section>)}
  </main>
}

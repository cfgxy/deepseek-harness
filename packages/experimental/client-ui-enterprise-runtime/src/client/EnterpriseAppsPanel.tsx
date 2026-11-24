import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RuntimeAppView } from '@deepseek-ai/dsh-experimental-enterprise-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './EnterpriseAppsPanel.module.css'

export interface EnterpriseAppsPanelProps extends PropsLocale<'enterpriseRuntime'> {
  readonly loadApps: () => Promise<RemoteResult<readonly RuntimeAppView[]>>
}

function PageDemo({ app, t }: { app: RuntimeAppView; t: EnterpriseAppsPanelProps['t'] }): ReactNode {
  const { page } = app
  if (page.kind === 'list') return <section className={css.demo} data-enterprise-runtime-demo="list">
    <div className={css.demoHeading}><span className={css.demoGlyph}>⌘</span><div>
      <p className={css.eyebrow}>LIVE COLLECTION</p><h2>{page.title}</h2>
    </div></div>
    <p className={css.demoCopy}>{t('demo.list')}</p>
    <div className={css.listResult}><span className={css.resultDot} /><span>{t('demo.listResult')}</span><small>Ready to query</small></div>
  </section>
  if (page.kind === 'detail') return <section className={css.demo} data-enterprise-runtime-demo="detail">
    <div className={css.demoHeading}><span className={css.demoGlyph}>◎</span><div>
      <p className={css.eyebrow}>RECORD VIEW</p><h2>{page.title}</h2>
    </div></div>
    <p className={css.demoCopy}>{t('demo.detail')}</p>
    <dl className={css.detailFields}>{page.fields?.map(field => <div key={field}><dt>{field}</dt><dd>{t('demo.value')}</dd></div>)}</dl>
  </section>
  if (page.kind === 'chart') return <section className={css.demo} data-enterprise-runtime-demo="chart">
    <div className={css.demoHeading}><span className={css.demoGlyph}>↗</span><div>
      <p className={css.eyebrow}>ANALYTICS</p><h2>{page.title}</h2>
    </div></div>
    <p className={css.demoCopy}>{t('demo.chart', { chart: page.chart ?? 'bar', x: page.x ?? '', y: page.y ?? '' })}</p>
    <div role="img" aria-label={t('demo.chartResult')} className={css.chart}><i /><i /><i /><span>{page.x} · {page.y}</span></div>
  </section>
  return <section className={css.demo} data-enterprise-runtime-demo="report">
    <div className={css.demoHeading}><span className={css.demoGlyph}>✦</span><div>
      <p className={css.eyebrow}>INSIGHT REPORT</p><h2>{page.title}</h2>
    </div></div>
    <p className={css.demoCopy}>{t('demo.report')}</p>
    {app.question !== undefined && <p className={css.question} data-enterprise-runtime-question>{app.question}</p>}
    <ol className={css.reportSections}>{page.sections?.map((section, index) => <li key={section}><b>{String(index + 1).padStart(2, '0')}</b>{section}</li>)}</ol>
  </section>
}

/** User-facing application plaza backed only by the Host's read-only app projection. */
export function EnterpriseAppsPanel({ loadApps, t }: EnterpriseAppsPanelProps): ReactNode {
  const [apps, setApps] = useState<readonly RuntimeAppView[] | undefined>()
  const [selected, setSelected] = useState<RuntimeAppView | undefined>()
  useEffect(() => { void loadApps().then(result => setApps(result.ok ? result.value : []), () => setApps([])) }, [loadApps])
  if (apps === undefined) return <main className={css.loading} data-enterprise-runtime-plaza aria-busy="true"><span /><p>Loading your workspace…</p></main>
  if (selected !== undefined) return <main className={css.appPage} data-enterprise-runtime-app>
    <button type="button" className={css.back} onClick={() => setSelected(undefined)}><span aria-hidden="true">←</span>{t('back')}</button>
    <section className={css.appHero}>
      <div className={css.appIcon} aria-hidden="true">{selected.app.icon}</div>
      <div><p className={css.categoryLabel}>{selected.app.category}</p><h1>{selected.app.name}</h1>
        <p className={css.appDescription}>{selected.app.description}</p>
      </div>
      <span className={css.version}>v{selected.version}</span>
    </section>
    <PageDemo app={selected} t={t} />
  </main>
  if (apps.length === 0) return <main className={css.empty} data-enterprise-runtime-plaza><div className={css.emptyOrb}>✦</div><h1>{t('panel')}</h1><p data-enterprise-runtime-empty>{t('empty')}</p></main>
  const categories = new Map<string, RuntimeAppView[]>()
  for (const app of apps) categories.set(app.app.category, [...categories.get(app.app.category) ?? [], app])
  return <main className={css.plaza} data-enterprise-runtime-plaza>
    <header className={css.hero}><div><p className={css.kicker}>ENTERPRISE WORKSPACE</p><h1>{t('panel')}</h1><p>{t('introPlaza')}</p></div><div className={css.heroMark} aria-hidden="true"><i /><i /><i /></div></header>
    <div className={css.summary}><span>{apps.length} applications</span><span>•</span><span>{categories.size} categories</span></div>
    {[...categories].map(([category, rows]) => <section className={css.category} key={category} data-enterprise-runtime-category={category}>
      <div className={css.categoryTitle}><h2>{category}</h2><span>{rows.length.toString().padStart(2, '0')}</span></div>
      <div className={css.grid}>{rows.map(app => <button type="button" key={`${app.id}@${app.version}`} className={css.card} onClick={() => setSelected(app)}>
        <span aria-hidden="true" className={css.icon}>{app.app.icon}</span><span className={css.cardArrow}>↗</span><strong>{app.app.name}</strong><small>{app.app.description}</small><em>{app.app.category}</em>
      </button>)}</div>
    </section>)}
  </main>
}

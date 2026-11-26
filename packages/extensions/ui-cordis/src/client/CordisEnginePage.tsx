/** Standalone main panel page for Self-Growing Engine (Cordis dynamic plugins / micro-apps). */
import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconCordisPluginOutlineRegular,
  IconPlayOutlineRegular, IconStopFillRegular, IconTrashOutlineRegular, StateDot, Tag,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { CordisRunActivity } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { CordisInventoryRow } from './dynamic-port.ts'
import type { CordisPanelFace } from './slots.ts'
import type { CordisKey } from './locales.ts'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId,
} from './events.ts'
import { cordisVisibleStatus, packageOf, type CordisVisibleStatus } from './status.ts'
import styles from './CordisEnginePage.module.css'

export type CordisEnginePageProps =
  PropsRuntime<'main'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>

export type EngineCategory = 'all' | 'ranking' | 'analytics' | 'tools' | 'custom'

type PanelStatus = CordisVisibleStatus | 'awaiting-approval' | 'failed'

const STATUS_LABELS = {
  idle: 'status.idle',
  'awaiting-approval': 'status.awaitingApproval',
  'client-pending': 'status.clientPending',
  running: 'status.running',
  failed: 'status.failed',
} as const satisfies Record<PanelStatus, CordisKey>

export function classifyApp(name: string, purpose: string): 'ranking' | 'analytics' | 'tools' | 'custom' {
  const text = `${name} ${purpose}`.toLowerCase()
  if (/排行|排名|榜单|top|rank|leaderboard|score|rating/.test(text)) {
    return 'ranking'
  }
  if (/分析|报表|统计|指标|看板|大盘|图表|趋势|analytics|report|stat|metric|dashboard|chart|trend/.test(text)) {
    return 'analytics'
  }
  if (
    /工具|转换|导入|导出|同步|助手|生成|查询|检索/.test(text)
    || /tool|convert|import|export|sync|helper|query|fetch|search/.test(text)
  ) {
    return 'tools'
  }
  return 'custom'
}

function panelDotState(status: PanelStatus, busy: boolean): StateDotState {
  if (busy) return 'ongoing'
  switch (status) {
    case 'idle': return 'idle'
    case 'client-pending': return 'ongoing'
    case 'running': return 'done'
    case 'awaiting-approval': return 'warning'
    case 'failed': return 'error'
  }
}

interface RowView {
  readonly pluginId: CordisDynamicPluginId
  readonly agentId: SessionId
  readonly listed?: CordisInventoryRow
  readonly activity?: CordisRunActivity
}

function selectedPackageIdOf(
  { pluginId, listed, activity }: RowView,
  selected: Readonly<Record<string, CordisDynamicPackageId>>,
): CordisDynamicPackageId | undefined {
  const selectedPackageId = selected[pluginId]
  if (selectedPackageId !== undefined
    && listed?.packages.some(pkg => pkg.packageId === selectedPackageId)) return selectedPackageId
  return listed?.nextPackageId
    ?? listed?.currentPackageId
    ?? listed?.packages.at(-1)?.packageId
    ?? activity?.packageId
}

function visiblePanelStatus(
  view: RowView,
  selectedPackageId: CordisDynamicPackageId | undefined,
  loaded: Parameters<typeof cordisVisibleStatus>[2],
): PanelStatus {
  const { listed, activity } = view
  const latest = listed?.latestRun
  if (activity?.phase === 'awaiting-approval' || latest?.status === 'awaiting-approval') {
    return 'awaiting-approval'
  }
  if (latest?.status === 'failed' && latest.packageId === selectedPackageId) return 'failed'
  if (listed?.activeRun === undefined) return 'idle'
  return cordisVisibleStatus(listed, listed.activeRun.packageId, loaded)
}

export function CordisEnginePage(props: CordisEnginePageProps) {
  const {
    useInventory, useActiveRuns, useRunErrors, useLoaded, useRenderFailures,
    onApprove, onDecline, onRun, onStop, onRemove, onRefresh, t,
  } = props

  const inventory = useInventory(snapshot => snapshot)
  const activeRuns = useActiveRuns(snapshot => snapshot)
  const errors = useRunErrors(snapshot => snapshot)
  const loaded = useLoaded(snapshot => snapshot)
  const renderFailures = useRenderFailures(snapshot => snapshot)

  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<EngineCategory>('all')
  const [selected, setSelected] = useState<Record<string, CordisDynamicPackageId>>({})
  const [pending, setPending] = useState<ReadonlySet<CordisDynamicPluginId>>(new Set())
  const [actionErrors, setActionErrors] = useState<ReadonlyMap<CordisDynamicPluginId, string>>(new Map())

  useEffect(() => { onRefresh() }, [onRefresh])

  const byPlugin = new Map<CordisDynamicPluginId, RowView>()
  for (const listed of inventory.rows) {
    const activity = activeRuns.get(listed.pluginId)
    byPlugin.set(listed.pluginId, {
      pluginId: listed.pluginId,
      agentId: activity?.agentId ?? listed.agentId,
      listed,
      ...activity === undefined ? {} : { activity },
    })
  }
  for (const [pluginId, activity] of activeRuns) {
    if (byPlugin.has(pluginId)) continue
    byPlugin.set(pluginId, { pluginId, agentId: activity.agentId, activity })
  }
  const allRows = [...byPlugin.values()]

  const allApps = useMemo(() => {
    return allRows.map((view) => {
      const { pluginId, listed, activity } = view
      const selectedPackageId = selectedPackageIdOf(view, selected)
      const selectedPackage = listed !== undefined && selectedPackageId !== undefined
        ? packageOf(listed, selectedPackageId)
        : undefined
      const name = selectedPackage?.name
        ?? (activity?.phase === 'awaiting-approval' ? activity.name : pluginId)
      const purpose = selectedPackage?.purpose
        ?? (activity?.phase === 'awaiting-approval' ? activity.purpose : '')
      const category = classifyApp(name, purpose)
      const status = visiblePanelStatus(view, selectedPackageId, loaded)
      const isRunning = status === 'running'
      const awaiting = activity?.phase === 'awaiting-approval'
        ? activity.requestId
        : listed?.latestRun?.status === 'awaiting-approval' ? listed.latestRun.approvalRequestId : undefined

      return {
        view,
        pluginId,
        agentId: view.agentId,
        listed,
        activity,
        name,
        purpose,
        category,
        status,
        isRunning,
        awaiting,
        selectedPackageId,
        selectedPackage,
        packages: listed?.packages ?? [],
      }
    })
  }, [allRows, loaded, selected])

  const runningCount = allApps.filter(app => app.isRunning).length

  const categoryCounts = useMemo(() => ({
    all: allApps.length,
    ranking: allApps.filter(a => a.category === 'ranking').length,
    analytics: allApps.filter(a => a.category === 'analytics').length,
    tools: allApps.filter(a => a.category === 'tools').length,
    custom: allApps.filter(a => a.category === 'custom').length,
  }), [allApps])

  const filteredApps = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allApps.filter((app) => {
      if (activeCategory !== 'all' && app.category !== activeCategory) return false
      if (query !== '') {
        const match = app.name.toLowerCase().includes(query)
          || app.purpose.toLowerCase().includes(query)
          || app.pluginId.toLowerCase().includes(query)
        if (!match) return false
      }
      return true
    })
  }, [activeCategory, allApps, search])

  const runAction = async (pluginId: CordisDynamicPluginId, action: () => Promise<void | { ok: boolean; message?: string }>) => {
    if (pending.has(pluginId)) return
    setPending(current => new Set(current).add(pluginId))
    setActionErrors((current) => {
      const next = new Map(current)
      next.delete(pluginId)
      return next
    })
    try {
      const result = await action()
      if (result !== undefined && !result.ok) {
        setActionErrors(current => new Map(current).set(pluginId, result.message ?? 'operation failed'))
      }
    } catch (error) {
      setActionErrors(current => new Map(current).set(pluginId, error instanceof Error ? error.message : String(error)))
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(pluginId)
        return next
      })
      onRefresh()
    }
  }

  return (
    <div className={styles.page} data-global-panel="cordis">
      <div className={styles.container}>
        <header className={styles.pageHeader}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>{t('engine.title')}</h1>
            <p className={styles.pageSubtitle}>{t('engine.subtitle')}</p>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.runningBadge}>
              <StateDot state={runningCount > 0 ? 'done' : 'idle'} />
              {t('engine.runningCountBadge', { count: runningCount })}
            </span>
            <Button variant="outline" onClick={() => { onRefresh() }}>
              {t('action.retry')}
            </Button>
          </div>
        </header>

        <section className={styles.toolbar}>
          <div className={styles.searchBar}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder={t('engine.searchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className={styles.tabs} role="tablist">
            {(['all', 'ranking', 'analytics', 'tools', 'custom'] as const).map((cat) => {
              const active = activeCategory === cat
              const count = categoryCounts[cat]
              return (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`${styles.tab} ${active ? styles.tabActive : ''}`}
                  onClick={() => setActiveCategory(cat)}
                >
                  <span>{t(`engine.tab.${cat}` as CordisKey)}</span>
                  <span className={styles.tabBadge}>{count}</span>
                </button>
              )
            })}
          </div>
        </section>

        {filteredApps.length === 0 ? (
          <div className={styles.empty}>
            <IconCordisPluginOutlineRegular size={40} />
            <h2 className={styles.emptyTitle}>
              {allApps.length === 0 ? t('engine.emptyTitle') : t('engine.emptyCategory')}
            </h2>
            <p className={styles.emptyDesc}>
              {t('engine.emptyDesc')}
            </p>
            <div className={styles.samplePrompt}>
              💡 <span>
                {t('engine.quickPrompt' as CordisKey)
                  || '示例：基于已接入数据源，帮我制作一个销售业绩排行榜小应用'}
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.list} role="list">
            {filteredApps.map((app) => {
              const {
                pluginId, listed, name, purpose, category, status, awaiting,
                selectedPackageId, selectedPackage, packages,
              } = app
              const busy = pending.has(pluginId)
              const actionError = actionErrors.get(pluginId)
              const failure = errors.get(pluginId)
              const hostFailure = listed?.latestRun?.status === 'failed' ? listed.latestRun.error : undefined
              const renderFailure = renderFailures.get(pluginId)
              const runMode = listed?.currentPackageId !== undefined
                && selectedPackageId !== listed.currentPackageId ? 'update' as const : 'run' as const

              return (
                <article key={pluginId} className={styles.card} role="listitem">
                  <div className={styles.cardHead}>
                    <div className={styles.cardIdentity}>
                      <span className={styles.appName}>{name}</span>
                      <Tag tone={category === 'ranking' ? 'success' : category === 'analytics' ? 'info' : 'neutral'}>
                        {t(`engine.category.${category}` as CordisKey)}
                      </Tag>
                      <span className={styles.appId}>{pluginId}</span>
                    </div>
                    <div className={styles.cardStatus}>
                      <StateDot state={panelDotState(status, busy)} />
                      <span>{t(STATUS_LABELS[status])}</span>
                    </div>
                  </div>

                  <p className={styles.appPurpose}>{purpose || t('purpose.missing')}</p>

                  <div className={styles.cardMetaRow}>
                    {packages.length > 1 && selectedPackageId !== undefined ? (
                      <label className={styles.versionPicker}>
                        <span>{t('panel.version')}</span>
                        <select
                          className={styles.versionSelect}
                          value={selectedPackageId}
                          disabled={busy}
                          onChange={(e) => {
                            setSelected(cur => ({
                              ...cur,
                              [pluginId]: e.target.value as CordisDynamicPackageId,
                            }))
                          }}
                        >
                          {packages.map(pkg => (
                            <option key={pkg.packageId} value={pkg.packageId}>
                              {pkg.name ? `${pkg.name} · ${pkg.packageId}` : pkg.packageId}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : <span />}

                    <div className={styles.cardActions}>
                      {awaiting !== undefined ? (
                        <>
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() => {
                              void runAction(pluginId, async () => {
                                await onApprove(awaiting, false)
                              })
                            }}
                          >
                            <IconCheckOutlineRegular size={14} /> {t('action.approveOnce')}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              void runAction(pluginId, async () => {
                                await onDecline(awaiting)
                              })
                            }}
                          >
                            <IconCloseOutlineRegular size={14} /> {t('action.decline')}
                          </Button>
                        </>
                      ) : null}

                      {awaiting === undefined
                        && listed !== undefined
                        && listed.activeRun === undefined
                        && selectedPackageId !== undefined ? (
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() => {
                              void runAction(pluginId, () => onRun({
                                agentId: listed.agentId,
                                pluginId,
                                packageId: selectedPackageId,
                                mode: runMode,
                                hasClientHalf: selectedPackage?.hasClientHalf === true,
                              }))
                            }}
                          >
                            <IconPlayOutlineRegular size={14} /> {t('action.run')}
                          </Button>
                        ) : null}

                      {awaiting === undefined && listed !== undefined && listed.activeRun !== undefined ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            void runAction(pluginId, () => onStop(listed.agentId, pluginId))
                          }}
                        >
                          <IconStopFillRegular size={14} /> {t('action.stop')}
                        </Button>
                      ) : null}

                      {awaiting === undefined && listed !== undefined ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            void runAction(pluginId, () => onRemove(listed.agentId, pluginId))
                          }}
                        >
                          <IconTrashOutlineRegular size={14} /> {t('action.remove')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {actionError ? <div className={styles.cardError} role="alert">{actionError}</div> : null}
                  {failure ? (
                    <div className={styles.cardError} role="alert">{`${failure.message} (${failure.reason})`}</div>
                  ) : null}
                  {hostFailure ? (
                    <div className={styles.cardError} role="alert">{`${hostFailure.message} (${hostFailure.phase})`}</div>
                  ) : null}
                  {renderFailure ? (
                    <div className={styles.cardError} role="alert">{`${renderFailure.slot}: ${renderFailure.message}`}</div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Standalone main panel page for Data Sources management. */
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { DataSourcesCard, type DataSourcesCardProps } from './DataSourcesCard.tsx'
import type { DataSourcesCardFace } from './settings-controller.ts'
import styles from './DataSourcesPage.module.css'

export type DataSourcesPageProps = PropsRuntime<'main'> & PropsLocale<'settings.dataSources'> & InjectFace<DataSourcesCardFace>

export function DataSourcesPage(props: DataSourcesPageProps) {
  return (
    <div className={styles.page} data-global-panel="data-sources">
      <div className={styles.container}>
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>{props.t('pageTitle')}</h1>
          <p className={styles.pageSubtitle}>{props.t('pageSubtitle')}</p>
        </header>
        <DataSourcesCard {...(props as unknown as DataSourcesCardProps)} />
      </div>
    </div>
  )
}

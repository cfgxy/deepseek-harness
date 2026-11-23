import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

const ENTERPRISE_BUNDLE = '@deepseek-ai/dsh-experimental-enterprise-runtime-bundle'

export function EnterpriseRuntimePrototype({ subject, t }: PluginDetailProps & PropsLocale<'enterpriseRuntime'>): ReactNode {
  if (subject.kind !== 'bundle' || subject.pkg.name !== ENTERPRISE_BUNDLE) return null
  return <section data-enterprise-runtime-prototype>
    <h3>{t('heading')}</h3>
    <p>{t('intro')}</p>
    <ul>
      <li>{t('list')}</li>
      <li>{t('detail')}</li>
      <li>{t('chart')}</li>
      <li>{t('report')}</li>
    </ul>
    <p>{t('langfuse')}</p>
  </section>
}

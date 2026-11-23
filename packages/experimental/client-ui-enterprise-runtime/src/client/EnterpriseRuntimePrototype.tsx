import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

const ENTERPRISE_BUNDLE = '@deepseek-ai/dsh-experimental-enterprise-runtime-bundle'

export function EnterpriseRuntimePrototype({ subject }: PluginDetailProps): ReactNode {
  if (subject.kind !== 'bundle' || subject.pkg.name !== ENTERPRISE_BUNDLE) return null
  return <section data-enterprise-runtime-prototype>
    <h3>Enterprise capability prototypes</h3>
    <p>The Runtime API v1 returns lossless JSON and accepts only declarative templates.</p>
    <ul>
      <li>List: a queryable collection.</li>
      <li>Detail: selected fields for one record.</li>
      <li>Chart: bar, line, or pie data projection.</li>
      <li>Report: ordered JSON-safe sections.</li>
    </ul>
    <p>Langfuse example: “How many traces were recorded in the selected period?” No Langfuse connector is bundled.</p>
  </section>
}

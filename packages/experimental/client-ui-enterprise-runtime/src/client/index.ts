import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'

export { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'

/** Contribute the reusable capability description beneath the Plugin Manager sidebar detail page. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section', id: 'enterprise-runtime.prototype', order: 100,
  }, EnterpriseRuntimePrototype))
}

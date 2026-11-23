import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export { EnterpriseRuntimePrototype } from './EnterpriseRuntimePrototype.tsx'
export { NS, type EnterpriseRuntimeLocaleKey } from './locales.ts'

/** Services required to register the Plugin Manager detail contribution and its dictionaries. */
export const inject = ['slots', 'locale']

/** Contribute the reusable capability description beneath the Plugin Manager sidebar detail page. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-enterprise-runtime: dictionaries')
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section', id: 'enterprise-runtime.prototype', order: 100, locale: NS,
  }, EnterpriseRuntimePrototype))
}

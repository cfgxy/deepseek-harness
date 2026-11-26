/** Sidebar panel icon for Self-Growing Engine (Cordis dynamic plugins). */
import type { ReactNode } from 'react'
import { IconCordisPluginOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Cordis plugin glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function CordisPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconCordisPluginOutlineRegular size={size} />
}

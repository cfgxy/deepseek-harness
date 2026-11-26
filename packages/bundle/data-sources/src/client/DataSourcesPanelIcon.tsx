/** Sidebar panel icon for Data Sources integration. */
import type { ReactNode } from 'react'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the database glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function DataSourcesPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconDatabaseOutlineRegular size={size} />
}

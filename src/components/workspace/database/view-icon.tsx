import { IconValue } from "@/components/workspace/icon-value"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { getViewLayoutIcon } from "./database-layout-icons"
import { databaseViewIconKey } from "./property-icon"

/** The icon of a view: the one chosen for it, or the icon of its layout. */
export function ViewIcon({
  databaseId,
  viewId,
  layout,
  className,
}: {
  databaseId: string
  viewId: string
  layout: string
  className?: string
}) {
  const icon = useViewStateStore(
    (state) => state.iconOverrides[databaseViewIconKey(databaseId, viewId)],
  )
  const LayoutIcon = getViewLayoutIcon(layout)
  return (
    <IconValue value={icon} fallback={<LayoutIcon className={className} />} className={className} />
  )
}

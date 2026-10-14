import * as React from "react"
import { useDatabaseStore } from "../../database/database-store"
import { useTextStats } from "../use-text-stats"
import { useViewManualOrder, type ViewOrder } from "./use-view-order"

export interface AnchorOrder {
  /** The anchors the author placed by hand, in order (the first view's `manualOrder`). */
  order: string[]
  /** When each anchor was made, by note ID. */
  created: Record<string, number | null>
  /** Saves a new order; rejects when it could not be kept. */
  save: ViewOrder["save"]
}

/**
 * What puts the anchors of the workshop in the author's own order: the hand-placed order of the
 * anchors database's first view and the time each was made (read from the note index). The
 * panel, the story desk and the page of a text page all order anchors by this.
 */
export function useAnchorOrder(
  anchorsDatabaseId: string | null | undefined,
  refreshKey: number,
): AnchorOrder {
  const databases = useDatabaseStore((state) => state.databases)
  const stats = useTextStats(anchorsDatabaseId, refreshKey)
  const created = React.useMemo(
    () => Object.fromEntries(Object.entries(stats).map(([id, stat]) => [id, stat.created])),
    [stats],
  )
  const view = useViewManualOrder(
    databases.find((database) => database.databaseId === anchorsDatabaseId),
    refreshKey,
  )
  return { order: view.order, created, save: view.save }
}

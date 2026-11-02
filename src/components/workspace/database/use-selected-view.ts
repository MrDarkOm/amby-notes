import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { useDatabaseStore } from "./database-store"

import { readLastView, rememberLastView } from "./last-view-memory"

interface UseSelectedViewParams {
  databaseId: string
  isNavigationTarget: boolean
  database: DatabaseSummary | undefined
}

export function useSelectedView({
  databaseId,
  isNavigationTarget,
  database,
}: UseSelectedViewParams) {
  const [selectedViewId, setSelectedViewIdState] = React.useState<string | null>(() =>
    readLastView(databaseId),
  )
  // The choice is kept per database, so reopening it (or the app) shows the same view.
  const setSelectedViewId = React.useCallback(
    (next: string | null) => {
      setSelectedViewIdState(next)
      if (next) rememberLastView(databaseId, next)
    },
    [databaseId],
  )
  // A workspace reused for another database starts from that database's last view.
  const [viewScope, setViewScope] = React.useState(databaseId)
  if (viewScope !== databaseId) {
    setViewScope(databaseId)
    setSelectedViewIdState(readLastView(databaseId))
  }
  const requestedView = useDatabaseStore((state) => state.requestedView)
  React.useEffect(() => {
    if (!isNavigationTarget || !database || requestedView?.databaseId !== database.databaseId)
      return
    if (database.views.some((view) => view.viewId === requestedView.viewId)) {
      setSelectedViewId(requestedView.viewId)
    }
    useDatabaseStore.getState().clearRequestedView(requestedView)
  }, [database, isNavigationTarget, requestedView, setSelectedViewId])

  return { selectedViewId, setSelectedViewId }
}

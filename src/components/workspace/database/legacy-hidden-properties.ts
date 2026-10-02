import * as React from "react"
import type { SavedView } from "./use-saved-view"

const STORAGE_KEY = "amby:db-view-hidden-properties"

function readLegacy(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

/**
 * Hidden columns used to live only in this browser's localStorage. Move a view's
 * entry into the view itself once, and forget the local copy only after the view
 * was saved. A view that already has hidden fields keeps them.
 */
export function useLegacyHiddenPropertiesMigration({
  databaseId,
  viewId,
  savedView,
  persisted,
}: {
  databaseId: string
  viewId: string | null
  savedView: SavedView
  persisted: boolean
}) {
  const { ready, settings, update, flush } = savedView
  const hiddenNow = settings.hidden.length
  React.useEffect(() => {
    if (!ready || !viewId) return
    const key = `${databaseId}:${viewId}`
    const legacy = readLegacy()
    const list = legacy[key]
    if (!Array.isArray(list) || list.length === 0) return
    if (hiddenNow === 0) update({ hidden: list.filter((id) => typeof id === "string") })
    if (!persisted) return
    void flush().then((saved) => {
      if (!saved) return
      try {
        const rest = readLegacy()
        delete rest[key]
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
      } catch {
        // The local copy is only a leftover; keeping it is harmless.
      }
    })
    // Run once per view: later hides must not re-import the old list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, databaseId, viewId])
}

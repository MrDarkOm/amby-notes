import * as React from "react"
import { getDatabaseView, updateDatabaseViewConfig, type DatabaseSummary } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { applySettingsPatch, parseViewSettings } from "../../database/view-config"

interface ViewDoc {
  viewId: string
  revision: string
  configJson: string
}

export interface ViewOrder {
  /** The note IDs the author placed by hand, in order; empty until something was placed. */
  order: string[]
  /** Saves a new order into the database's first view; rejects when the file refuses it. */
  save: (next: string[]) => Promise<void>
}

/**
 * The order of the rows the author placed by hand in a database's first view (`manualOrder`, the
 * same list the table shows while it has no sort). Nothing is stored of the workshop's own: a
 * list reordered here and the table of that database are one order.
 */
export function useViewManualOrder(
  summary: DatabaseSummary | undefined,
  refreshKey: number,
): ViewOrder {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const [doc, setDoc] = React.useState<ViewDoc | null>(null)
  const databaseId = summary?.databaseId ?? null
  const view = summary?.views[0] ?? null
  const viewId = view?.viewId ?? null
  const viewRevision = view?.revision ?? null

  React.useEffect(() => {
    if (!databaseId || !viewId || viewRevision === null || vaultGeneration === null) {
      setDoc(null)
      return undefined
    }
    let cancelled = false
    getDatabaseView({
      expectedGeneration: vaultGeneration,
      databaseId,
      viewId,
      expectedViewRevision: viewRevision,
    })
      .then((loaded) => {
        if (!cancelled) {
          setDoc({ viewId, revision: loaded.revision, configJson: loaded.configJson })
        }
      })
      .catch(() => {
        // The order is a nicety: without it the list keeps the order the pages were made in.
        if (!cancelled) setDoc(null)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, viewId, viewRevision, vaultGeneration, refreshKey])

  const order = React.useMemo(
    () => (doc ? parseViewSettings(doc.configJson).manualOrder : []),
    [doc],
  )

  const save = React.useCallback(
    async (next: string[]) => {
      if (!doc || !databaseId || vaultGeneration === null) {
        throw new Error("The order cannot be saved: the list has no view to keep it in.")
      }
      const configJson = applySettingsPatch(doc.configJson, { manualOrder: next })
      const result = await updateDatabaseViewConfig({
        expectedGeneration: vaultGeneration,
        databaseId,
        viewId: doc.viewId,
        expectedViewRevision: doc.revision,
        configJson,
      })
      setDoc({ viewId: doc.viewId, revision: result.viewRevision, configJson })
    },
    [databaseId, doc, vaultGeneration],
  )

  return { order, save }
}

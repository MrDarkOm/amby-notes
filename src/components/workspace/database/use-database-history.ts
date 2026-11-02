import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { undoDatabaseMutation, redoDatabaseMutation, getDatabaseHistoryStatus } from "@/lib/storage"

interface UseDatabaseHistoryParams {
  databaseId: string
  database: DatabaseSummary | undefined
  isDatabaseLocked: boolean
  retry: () => Promise<void>
  onCatalogChanged: (() => Promise<void>) | undefined
}

export function useDatabaseHistory({
  databaseId,
  database,
  isDatabaseLocked,
  retry,
  onCatalogChanged,
}: UseDatabaseHistoryParams) {
  const [historyStatus, setHistoryStatus] = React.useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  })

  const refreshHistoryStatus = React.useCallback(async () => {
    try {
      const status = await getDatabaseHistoryStatus(databaseId)
      setHistoryStatus({ canUndo: status.canUndo, canRedo: status.canRedo })
    } catch {
      // ignore
    }
  }, [databaseId])

  React.useEffect(() => {
    void refreshHistoryStatus()
  }, [refreshHistoryStatus, database])

  const handleUndo = React.useCallback(async () => {
    if (!historyStatus.canUndo || isDatabaseLocked) return
    try {
      const result = await undoDatabaseMutation(databaseId)
      setHistoryStatus({ canUndo: result.canUndo, canRedo: result.canRedo })
      await retry()
      if (onCatalogChanged) {
        await onCatalogChanged()
      }
    } catch (err) {
      console.error("Undo failed:", err)
    }
  }, [historyStatus.canUndo, isDatabaseLocked, databaseId, retry, onCatalogChanged])

  const handleRedo = React.useCallback(async () => {
    if (!historyStatus.canRedo || isDatabaseLocked) return
    try {
      const result = await redoDatabaseMutation(databaseId)
      setHistoryStatus({ canUndo: result.canUndo, canRedo: result.canRedo })
      await retry()
      if (onCatalogChanged) {
        await onCatalogChanged()
      }
    } catch (err) {
      console.error("Redo failed:", err)
    }
  }, [historyStatus.canRedo, isDatabaseLocked, databaseId, retry, onCatalogChanged])

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && !e.altKey) {
        if (e.key === "z" || e.key === "Z" || e.key === "я" || e.key === "Я") {
          if (e.shiftKey) {
            e.preventDefault()
            void handleRedo()
          } else {
            e.preventDefault()
            void handleUndo()
          }
        } else if (!isMac && (e.key === "y" || e.key === "Y")) {
          e.preventDefault()
          void handleRedo()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleUndo, handleRedo])

  return { historyStatus, refreshHistoryStatus, handleUndo, handleRedo }
}

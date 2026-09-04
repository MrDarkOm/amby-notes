import * as React from "react"
import { listen } from "@tauri-apps/api/event"
import {
  DatabaseOperationError,
  getDatabaseModuleState,
  isTauri,
  listDatabases,
  rebuildDatabaseProjection,
  setDatabaseModuleEnabled,
  type DatabaseChangedPayload,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

interface DatabaseControllerOptions {
  enabled: boolean
  vaultGeneration: number | null
}

function errorMessage(error: unknown): string {
  if (error instanceof DatabaseOperationError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** Owns runtime lifecycle and catalog invalidation; table hosts fetch on demand. */
export function useDatabaseController({ enabled, vaultGeneration }: DatabaseControllerOptions) {
  const previousEnabled = React.useRef(false)
  const reset = useDatabaseStore((state) => state.reset)
  const setRuntime = useDatabaseStore((state) => state.setRuntime)
  const setCatalogLoading = useDatabaseStore((state) => state.setCatalogLoading)
  const setCatalog = useDatabaseStore((state) => state.setCatalog)
  const setCatalogError = useDatabaseStore((state) => state.setCatalogError)
  const setCatalogDisabled = useDatabaseStore((state) => state.setCatalogDisabled)

  const refreshCatalog = React.useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (signal?.cancelled) return
      setCatalogLoading()
      try {
        const databases = await listDatabases()
        if (signal?.cancelled) return
        setCatalog(databases)
      } catch (error) {
        if (!signal?.cancelled) setCatalogError(errorMessage(error))
      }
    },
    [setCatalog, setCatalogError, setCatalogLoading],
  )

  React.useEffect(() => {
    const wasEnabled = previousEnabled.current
    previousEnabled.current = enabled
    reset(vaultGeneration)

    if (!enabled || vaultGeneration === null) {
      if (wasEnabled && vaultGeneration !== null) {
        void setDatabaseModuleEnabled(false, vaultGeneration).catch(() => {})
      }
      if (!enabled) setCatalogDisabled()
      return
    }

    const signal = { cancelled: false }
    let dispose: (() => void) | undefined
    void (async () => {
      try {
        let runtime = await getDatabaseModuleState()
        if (signal.cancelled) return
        if (!runtime.enabled || runtime.vaultGeneration !== vaultGeneration) {
          runtime = await setDatabaseModuleEnabled(true, vaultGeneration)
        }
        if (signal.cancelled) return
        setRuntime(runtime)
        await refreshCatalog(signal)
        if (signal.cancelled || !isTauri()) return
        dispose = await listen<DatabaseChangedPayload>("database:changed", () => {
          void (async () => {
            try {
              await rebuildDatabaseProjection()
            } catch {
              // The next catalog refresh still exposes diagnostics when a
              // malformed source keeps the prior projection read-only.
            }
            await refreshCatalog(signal)
          })()
        })
        if (signal.cancelled) dispose?.()
      } catch (error) {
        if (!signal.cancelled) setCatalogError(errorMessage(error))
      }
    })()

    return () => {
      signal.cancelled = true
      dispose?.()
    }
  }, [
    enabled,
    refreshCatalog,
    reset,
    setCatalogDisabled,
    setCatalogError,
    setRuntime,
    vaultGeneration,
  ])
}

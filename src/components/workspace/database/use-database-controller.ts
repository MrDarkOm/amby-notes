import * as React from "react"
import { listen } from "@tauri-apps/api/event"
import {
  getDatabaseModuleState,
  isTauri,
  listDatabases,
  refreshDatabaseChange,
  rebuildDatabaseProjection,
  setDatabaseModuleEnabled,
  type DatabaseChangedPayload,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { operationErrorCode, reportOperationError } from "@/lib/operation-errors"
import { logger } from "@/lib/logger"

interface DatabaseControllerOptions {
  enabled: boolean
  vaultGeneration: number | null
}

function errorMessage(error: unknown): string {
  return reportOperationError(error)
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
  const invalidateHosts = useDatabaseStore((state) => state.invalidateHosts)

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
        void setDatabaseModuleEnabled(false, vaultGeneration).catch((error: unknown) => {
          // The screen is already switched off; the backend learns it again on the next open.
          logger.debug("database.module_disable_failed", { failureCode: operationErrorCode(error) })
        })
      }
      if (!enabled) setCatalogDisabled()
      return
    }

    const signal = { cancelled: false }
    const registration = (async () => {
      try {
        let runtime = await getDatabaseModuleState()
        if (signal.cancelled) return undefined
        if (!runtime.enabled || runtime.vaultGeneration !== vaultGeneration) {
          runtime = await setDatabaseModuleEnabled(true, vaultGeneration)
        }
        if (signal.cancelled) return undefined
        setRuntime(runtime)
        await refreshCatalog(signal)
        if (signal.cancelled || !isTauri()) return undefined
        let refreshTimer: ReturnType<typeof setTimeout> | null = null
        let refreshInFlight = false
        let localWritePending = false
        const pending = new Map<string, DatabaseChangedPayload>()
        const scheduleRefresh = () => {
          if (refreshTimer !== null || signal.cancelled) return
          refreshTimer = setTimeout(() => {
            refreshTimer = null
            void flushChanges()
          }, 100)
        }
        const flushChanges = async () => {
          if (refreshInFlight || (pending.size === 0 && !localWritePending) || signal.cancelled)
            return
          refreshInFlight = true
          const changes = [...pending.values()]
          pending.clear()
          localWritePending = false
          try {
            const requiresFullRebuild = changes.some(
              (change) =>
                change.requiresFullRebuild ||
                change.kind === "manifest" ||
                change.kind === "template" ||
                change.kind === "container",
            )
            let nextRuntime = runtime
            if (requiresFullRebuild) {
              nextRuntime = await rebuildDatabaseProjection()
            } else {
              try {
                for (const change of changes) {
                  nextRuntime = await refreshDatabaseChange(change)
                }
              } catch {
                // A deleted or malformed shard may no longer support an
                // incremental update. Rebuild once to publish diagnostics.
                nextRuntime = await rebuildDatabaseProjection()
              }
            }
            if (!signal.cancelled && changes.length > 0) setRuntime(nextRuntime)
          } catch {
            // The next catalog refresh still exposes diagnostics when a
            // malformed source keeps the prior projection read-only.
          } finally {
            refreshInFlight = false
            if (!signal.cancelled) {
              await refreshCatalog(signal)
              if (!signal.cancelled) invalidateHosts()
              if (pending.size > 0 || localWritePending) scheduleRefresh()
            }
          }
        }
        const stopExternal = await listen<DatabaseChangedPayload>("database:changed", (event) => {
          if (event.payload.generation !== vaultGeneration) return
          const key = `${event.payload.kind}:${event.payload.path}`
          pending.set(key, event.payload)
          scheduleRefresh()
        })
        try {
          const stopLocal = await listen<{ generation: number }>(
            "amby:database-written",
            (event) => {
              if (event.payload.generation !== vaultGeneration) return
              localWritePending = true
              scheduleRefresh()
            },
          )
          return () => {
            stopExternal()
            stopLocal()
          }
        } catch (error) {
          stopExternal()
          throw error
        }
      } catch (error) {
        if (!signal.cancelled) setCatalogError(errorMessage(error))
        return undefined
      }
    })()
    const cleanupListener = adoptAsyncDisposer(registration, () => {})

    return () => {
      signal.cancelled = true
      cleanupListener()
    }
  }, [
    enabled,
    invalidateHosts,
    refreshCatalog,
    reset,
    setCatalogDisabled,
    setCatalogError,
    setRuntime,
    vaultGeneration,
  ])

  return { refreshCatalog }
}

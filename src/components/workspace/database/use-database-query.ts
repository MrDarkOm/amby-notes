import * as React from "react"
import { DatabaseOperationError, queryDatabase, type DatabaseRow } from "@/lib/storage"
import {
  databaseHostKey,
  emptyDatabaseHost,
  useDatabaseStore,
  type DatabaseHostKind,
} from "./database-store"

const DEFAULT_PAGE_SIZE = 100

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStaleCursor(error: unknown): boolean {
  return error instanceof DatabaseOperationError && /stale cursor/i.test(error.message)
}

interface UseDatabaseQueryOptions {
  databaseId: string
  vaultGeneration: number | null
  enabled: boolean
  viewId?: string | null
  hostKind?: DatabaseHostKind
  hostId?: string | null
}

export function useDatabaseQuery({
  databaseId,
  vaultGeneration,
  enabled,
  viewId = null,
  hostKind = "tab",
  hostId = null,
}: UseDatabaseQueryOptions) {
  const key = databaseHostKey(hostKind, databaseId, viewId, hostId)
  const host = useDatabaseStore((state) => state.hosts[key])
  const runtime = useDatabaseStore((state) => state.runtime)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const setHost = useDatabaseStore((state) => state.setHost)
  const requestSerial = React.useRef(0)

  const loadPage = React.useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!enabled || vaultGeneration === null) return
      const serial = ++requestSerial.current
      const currentInvalidationSeq = useDatabaseStore.getState().invalidationSeq
      const current =
        useDatabaseStore.getState().hosts[key] ??
        emptyDatabaseHost(hostKind, databaseId, viewId, hostId, currentInvalidationSeq)
      setHost({ ...current, status: "loading", error: null })
      try {
        const result = await queryDatabase({
          expectedGeneration: vaultGeneration,
          databaseId,
          source: viewId
            ? { kind: "savedView", viewId }
            : {
                kind: "inline",
                spec: {
                  sorts: [
                    {
                      field: { kind: "system", field: "title" },
                      direction: "asc",
                      nulls: "last",
                    },
                  ],
                },
              },
          page: { limit: DEFAULT_PAGE_SIZE, cursor: cursor ?? undefined },
        })
        const state = useDatabaseStore.getState()
        if (serial !== requestSerial.current || state.vaultGeneration !== vaultGeneration) return
        const latest = state.hosts[key] ?? current
        const rows: DatabaseRow[] = append ? [...latest.rows, ...result.rows] : result.rows
        setHost({
          ...latest,
          status: "ready",
          loadedInvalidationSeq: state.invalidationSeq,
          rows,
          projection: result.projection,
          diagnostics: result.diagnostics,
          error: null,
          nextCursor: result.nextCursor,
        })
      } catch (error) {
        if (serial !== requestSerial.current) return
        if (cursor && isStaleCursor(error)) {
          await loadPage(null, false)
          return
        }
        const latest = useDatabaseStore.getState().hosts[key] ?? current
        setHost({ ...latest, status: "error", error: messageOf(error) })
      }
    },
    [databaseId, enabled, hostId, hostKind, key, setHost, viewId, vaultGeneration],
  )

  React.useEffect(() => {
    requestSerial.current += 1
    if (!enabled || vaultGeneration === null || !runtime?.enabled) return

    // Host sessions live in the database store rather than in this component.
    // Reuse a ready/loading session when a tab or panel remounts; otherwise a
    // simple tab switch needlessly clears the rows and starts the query again.
    const cachedHost = useDatabaseStore.getState().hosts[key]
    if (
      cachedHost?.loadedInvalidationSeq === invalidationSeq &&
      (cachedHost.status === "loading" || cachedHost.status === "ready")
    ) {
      return
    }

    setHost(emptyDatabaseHost(hostKind, databaseId, viewId, hostId, invalidationSeq))
    void loadPage(null, false)
    return () => {
      requestSerial.current += 1
    }
  }, [
    databaseId,
    enabled,
    hostId,
    hostKind,
    invalidationSeq,
    key,
    loadPage,
    runtime?.enabled,
    setHost,
    vaultGeneration,
    viewId,
  ])

  const loadNextPage = React.useCallback(async () => {
    const latest = useDatabaseStore.getState().hosts[key]
    if (!latest || latest.status === "loading" || !latest.nextCursor) return
    await loadPage(latest.nextCursor, true)
  }, [key, loadPage])

  const retry = React.useCallback(async () => {
    await loadPage(null, false)
  }, [loadPage])

  return {
    host,
    loadNextPage,
    retry,
  }
}

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
}

export function useDatabaseQuery({
  databaseId,
  vaultGeneration,
  enabled,
  viewId = null,
  hostKind = "tab",
}: UseDatabaseQueryOptions) {
  const key = databaseHostKey(hostKind, databaseId, viewId)
  const host = useDatabaseStore((state) => state.hosts[key])
  const runtime = useDatabaseStore((state) => state.runtime)
  const setHost = useDatabaseStore((state) => state.setHost)
  const requestSerial = React.useRef(0)

  const loadPage = React.useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!enabled || vaultGeneration === null) return
      const serial = ++requestSerial.current
      const current =
        useDatabaseStore.getState().hosts[key] ?? emptyDatabaseHost(hostKind, databaseId, viewId)
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
    [databaseId, enabled, hostKind, key, setHost, viewId, vaultGeneration],
  )

  React.useEffect(() => {
    requestSerial.current += 1
    if (!enabled || vaultGeneration === null || !runtime?.enabled) return
    setHost(emptyDatabaseHost(hostKind, databaseId, viewId))
    void loadPage(null, false)
    return () => {
      requestSerial.current += 1
    }
  }, [databaseId, enabled, hostKind, loadPage, runtime?.enabled, setHost, vaultGeneration, viewId])

  const loadNextPage = React.useCallback(() => {
    const latest = useDatabaseStore.getState().hosts[key]
    if (!latest || latest.status === "loading" || !latest.nextCursor) return
    void loadPage(latest.nextCursor, true)
  }, [key, loadPage])

  const retry = React.useCallback(() => {
    void loadPage(null, false)
  }, [loadPage])

  return {
    host,
    loadNextPage,
    retry,
  }
}

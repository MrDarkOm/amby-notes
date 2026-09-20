import * as React from "react"
import * as storage from "@/lib/storage"
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
  return error instanceof storage.DatabaseOperationError && error.code === "staleCursor"
}

interface UseDatabaseQueryOptions {
  databaseId: string
  vaultGeneration: number | null
  enabled: boolean
  viewId?: string | null
  hostKind?: DatabaseHostKind
  hostId?: string | null
  search?: string
  filterValues?: Record<string, string>
  propertyTypes?: Record<string, string>
  sortValue?: { key: string; direction: "asc" | "desc" } | null
}

// Module-level map of in-flight query promises to prevent duplicate requests
// and prevent React StrictMode or fast re-renders from abandoning active queries.
const inFlightQueries = new Map<string, Promise<void>>()
const querySequences = new Map<string, number>()

export function clearInFlightQueries() {
  inFlightQueries.clear()
  querySequences.clear()
}

export const _clearInFlightQueriesForTesting = clearInFlightQueries

export function useDatabaseQuery({
  databaseId,
  vaultGeneration,
  enabled,
  viewId = null,
  hostKind = "tab",
  hostId = null,
  search = "",
  filterValues = {},
  propertyTypes,
  sortValue = null,
}: UseDatabaseQueryOptions) {
  const normalizedFilters = React.useMemo(() => {
    return Object.entries(filterValues).filter(
      ([, value]) => typeof value === "string" && value.trim().length > 0,
    )
  }, [filterValues])

  const queryIdentity = React.useMemo(() => {
    return JSON.stringify({
      q: search.trim(),
      s: sortValue ? { k: sortValue.key, d: sortValue.direction } : null,
      f: normalizedFilters,
      p: propertyTypes,
    })
  }, [normalizedFilters, propertyTypes, search, sortValue])

  const key = React.useMemo(
    () => databaseHostKey(hostKind, databaseId, viewId, hostId, queryIdentity),
    [databaseId, hostId, hostKind, queryIdentity, viewId],
  )
  const host = useDatabaseStore((state) => state.hosts[key])
  const runtime = useDatabaseStore((state) => state.runtime)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const setHost = useDatabaseStore((state) => state.setHost)

  const loadPage = React.useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!enabled || vaultGeneration === null) return

      const inFlightKey = `${vaultGeneration}:${key}:${cursor ?? "initial"}`
      const existingInFlight = inFlightQueries.get(inFlightKey)
      if (existingInFlight) {
        return existingInFlight
      }

      const requestSeq = (querySequences.get(key) ?? 0) + 1
      querySequences.set(key, requestSeq)

      const currentInvalidationSeq = useDatabaseStore.getState().invalidationSeq
      const current =
        useDatabaseStore.getState().hosts[key] ??
        emptyDatabaseHost(
          hostKind,
          databaseId,
          viewId,
          hostId,
          currentInvalidationSeq,
          queryIdentity,
        )

      setHost({ ...current, status: "loading", error: null })

      const promise = (async () => {
        try {
          const filter = normalizedFilters.length
            ? {
                kind: "group" as const,
                operator: "and" as const,
                children: normalizedFilters.map(([filterKey, filterVal]) => {
                  const propType =
                    propertyTypes?.[filterKey] ?? (filterKey === "title" ? "text" : undefined)
                  let operator: "contains" | "equals" | "notEquals" | "greaterThan" | "lessThan" =
                    "contains"
                  let val = filterVal
                  if (propType === "date" || propType === "number") {
                    if (val.startsWith(">")) {
                      operator = "greaterThan"
                      val = val.slice(1).trim()
                    } else if (val.startsWith("<")) {
                      operator = "lessThan"
                      val = val.slice(1).trim()
                    } else if (val.startsWith("!=")) {
                      operator = "notEquals"
                      val = val.slice(2).trim()
                    } else {
                      operator = "equals"
                      val = val.trim()
                    }
                  } else if (propType === "checkbox") {
                    operator = "equals"
                    val = val.trim()
                  }
                  return {
                    kind: "condition" as const,
                    field: (filterKey === "title"
                      ? { kind: "system", field: "title" }
                      : { kind: "property", propertyId: filterKey }) as storage.DatabaseFieldRef,
                    operator,
                    value:
                      propType === "checkbox"
                        ? JSON.stringify(val === "true" || val === "1")
                        : JSON.stringify(val),
                  }
                }),
              }
            : undefined

          const result = await storage.queryDatabase({
            expectedGeneration: vaultGeneration,
            databaseId,
            search: search.trim() || undefined,
            sorts: sortValue
              ? [
                  {
                    field:
                      sortValue.key === "title"
                        ? { kind: "system", field: "title" }
                        : { kind: "property", propertyId: sortValue.key },
                    direction: sortValue.direction,
                    nulls: "last",
                  },
                ]
              : undefined,
            filter,
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
          if (state.vaultGeneration !== vaultGeneration) {
            return
          }

          // If a newer query was scheduled for this same key, let that newer query set state
          if (querySequences.get(key) !== requestSeq) {
            return
          }

          const latest = state.hosts[key] ?? current
          const rows: storage.DatabaseRow[] = append
            ? [...latest.rows, ...result.rows]
            : result.rows
          setHost({
            ...latest,
            status: "ready",
            loadedInvalidationSeq: currentInvalidationSeq,
            rows,
            projection: result.projection,
            diagnostics: result.diagnostics,
            error: null,
            nextCursor: result.nextCursor,
            totalCount: result.totalCount,
          })
        } catch (error) {
          const state = useDatabaseStore.getState()
          if (state.vaultGeneration !== vaultGeneration) return

          if (cursor && isStaleCursor(error)) {
            void loadPage(null, false)
            return
          }

          if (querySequences.get(key) === requestSeq) {
            const latest = state.hosts[key] ?? current
            setHost({
              ...latest,
              status: "error",
              error: messageOf(error),
              loadedInvalidationSeq: currentInvalidationSeq,
            })
          }
        } finally {
          inFlightQueries.delete(inFlightKey)
        }
      })()

      inFlightQueries.set(inFlightKey, promise)
      return promise
    },
    [
      databaseId,
      enabled,
      hostId,
      hostKind,
      key,
      normalizedFilters,
      propertyTypes,
      queryIdentity,
      search,
      setHost,
      sortValue,
      vaultGeneration,
      viewId,
    ],
  )

  const loadPageRef = React.useRef(loadPage)
  loadPageRef.current = loadPage

  React.useEffect(() => {
    if (!enabled || vaultGeneration === null || !runtime?.enabled) return

    const cachedHost = useDatabaseStore.getState().hosts[key]
    const inFlightKey = `${vaultGeneration}:${key}:initial`
    const isAlreadyRunning = inFlightQueries.has(inFlightKey)

    // Reuse cached session when generation and invalidation match and query has already settled (ready or error)
    if (
      cachedHost?.loadedInvalidationSeq === invalidationSeq &&
      (cachedHost.status === "ready" || cachedHost.status === "error")
    ) {
      return
    }

    // If an initial query for this exact vaultGeneration and host key is already in flight,
    // let it finish and update the host session.
    if (isAlreadyRunning) {
      return
    }

    void loadPageRef.current(null, false)
  }, [enabled, invalidationSeq, key, runtime?.enabled, vaultGeneration])

  const loadNextPage = React.useCallback(async () => {
    const latest = useDatabaseStore.getState().hosts[key]
    if (!latest || latest.status === "loading" || !latest.nextCursor || vaultGeneration === null) {
      return
    }
    const inFlightKey = `${vaultGeneration}:${key}:${latest.nextCursor}`
    if (inFlightQueries.has(inFlightKey)) return
    await loadPage(latest.nextCursor, true)
  }, [key, loadPage, vaultGeneration])

  const retry = React.useCallback(async () => {
    const currentHost = useDatabaseStore.getState().hosts[key]
    if (currentHost?.error?.includes("not found")) {
      try {
        await storage.rebuildDatabaseProjection()
      } catch {
        // ignore projection rebuild errors and let loadPage surface query error
      }
    }
    await loadPage(null, false)
  }, [key, loadPage])

  return {
    host,
    loadNextPage,
    retry,
  }
}

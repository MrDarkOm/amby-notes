import * as React from "react"
import { queryDatabase, type DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"

const PAGE_SIZE = 200
const MAX_PAGES = 5

export interface DatabaseRowsState {
  /** Rows by database ID; a database that failed to load is absent. */
  rows: Record<string, DatabaseRow[]>
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  /** Some database had more rows than the list loads. */
  truncated: boolean
}

const IDLE: DatabaseRowsState = { rows: {}, status: "idle", error: null, truncated: false }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every row of some databases, read through the ordinary database query so the projection, the
 * generation check and its errors are the database's own. The previous rows stay on screen while
 * a refresh runs, so a list does not flash empty when a page is added.
 */
export function useDatabaseRows(databaseIds: string[], refreshKey: number): DatabaseRowsState {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [state, setState] = React.useState<DatabaseRowsState>(IDLE)
  const key = [...new Set(databaseIds)].sort().join("|")

  React.useEffect(() => {
    const ids = key ? key.split("|") : []
    if (ids.length === 0 || vaultGeneration === null) {
      setState(IDLE)
      return undefined
    }
    let cancelled = false
    setState((previous) => ({ ...previous, status: "loading", error: null }))
    void (async () => {
      const rows: Record<string, DatabaseRow[]> = {}
      let truncated = false
      let failure: string | null = null
      await Promise.all(
        ids.map(async (databaseId) => {
          try {
            let cursor: string | undefined
            const collected: DatabaseRow[] = []
            for (let page = 0; page < MAX_PAGES; page += 1) {
              const result = await queryDatabase({
                expectedGeneration: vaultGeneration,
                databaseId,
                source: { kind: "inline", spec: { sorts: [] } },
                page: { limit: PAGE_SIZE, cursor },
              })
              collected.push(...result.rows)
              if (!result.nextCursor) {
                cursor = undefined
                break
              }
              cursor = result.nextCursor
            }
            if (cursor) truncated = true
            rows[databaseId] = collected
          } catch (error) {
            failure = messageOf(error)
          }
        }),
      )
      if (cancelled) return
      setState({
        rows,
        status: failure && Object.keys(rows).length === 0 ? "error" : "ready",
        error: failure,
        truncated,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [key, vaultGeneration, invalidationSeq, refreshKey])

  return state
}

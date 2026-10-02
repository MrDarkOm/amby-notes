import * as React from "react"
import { searchRelationCandidates, type RelationCandidate } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

const PAGE_SIZE = 50
const SEARCH_DELAY_MS = 200

export type RelationCandidatesStatus = "idle" | "loading" | "loadingMore" | "ready" | "error"

export interface RelationCandidatesState {
  items: RelationCandidate[]
  status: RelationCandidatesStatus
  error: string | null
  hasMore: boolean
  /** Query the current `items` answer; differs from the input while typing. */
  settledQuery: string | null
  loadMore: () => void
  retry: () => void
}

/**
 * Server-side search over the whole target database with paging. A response for
 * an older query or page is dropped, and a failure is reported as an error,
 * never as an empty list (an empty list would invite creating a duplicate page).
 */
export function useRelationCandidates({
  databaseId,
  query,
  enabled,
}: {
  databaseId: string
  query: string
  enabled: boolean
}): RelationCandidatesState {
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [state, setState] = React.useState<{
    items: RelationCandidate[]
    status: RelationCandidatesStatus
    error: string | null
    cursor: string | null
    settledQuery: string | null
  }>({ items: [], status: "idle", error: null, cursor: null, settledQuery: null })
  const [retryTick, setRetryTick] = React.useState(0)
  const requestToken = React.useRef(0)
  const stateRef = React.useRef(state)
  stateRef.current = state

  React.useEffect(() => {
    if (!enabled || generation === null || !databaseId) return
    const token = ++requestToken.current
    const trimmed = query.trim()
    setState((current) => ({ ...current, status: "loading", error: null }))
    const timer = setTimeout(
      () => {
        searchRelationCandidates({
          expectedGeneration: generation,
          databaseId,
          search: trimmed || null,
          limit: PAGE_SIZE,
        }).then(
          (page) => {
            if (token !== requestToken.current) return
            setState({
              items: page.candidates,
              status: "ready",
              error: null,
              cursor: page.nextCursor,
              settledQuery: trimmed,
            })
          },
          (error) => {
            if (token !== requestToken.current) return
            setState((current) => ({
              ...current,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            }))
          },
        )
      },
      // The first, empty-query page opens instantly; typing is debounced.
      trimmed ? SEARCH_DELAY_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [enabled, generation, databaseId, query, retryTick, invalidationSeq])

  const loadMore = React.useCallback(() => {
    const current = stateRef.current
    if (!enabled || generation === null || current.status !== "ready" || !current.cursor) return
    const token = ++requestToken.current
    setState((previous) => ({ ...previous, status: "loadingMore" }))
    searchRelationCandidates({
      expectedGeneration: generation,
      databaseId,
      search: current.settledQuery || null,
      cursor: current.cursor,
      limit: PAGE_SIZE,
    }).then(
      (page) => {
        if (token !== requestToken.current) return
        setState((previous) => {
          const known = new Set(previous.items.map((item) => item.noteId))
          return {
            ...previous,
            items: [
              ...previous.items,
              ...page.candidates.filter((item) => !known.has(item.noteId)),
            ],
            status: "ready",
            cursor: page.nextCursor,
          }
        })
      },
      (error) => {
        if (token !== requestToken.current) return
        setState((previous) => ({
          ...previous,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }))
      },
    )
  }, [databaseId, enabled, generation])

  const retry = React.useCallback(() => setRetryTick((tick) => tick + 1), [])

  return {
    items: state.items,
    status: state.status,
    error: state.error,
    hasMore: state.cursor !== null,
    settledQuery: state.settledQuery,
    loadMore,
    retry,
  }
}

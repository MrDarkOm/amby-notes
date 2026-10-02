import * as React from "react"
import {
  aggregateDatabase,
  queryDatabase,
  type DatabaseFilterNode,
  type DatabaseOptionSummary,
  type DatabaseRow,
  type DatabaseSortSpec,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { safeOptionColor } from "./value-format"
import { EMPTY_BOARD_LANE, moveRowToBoardLane } from "./layouts/board-model"

const LANE_PAGE_SIZE = 50
const MAX_GROUPS = 256

export interface BoardLaneState {
  key: string
  /** Option name; `null` for the no-value lane and for options missing from the schema. */
  label: string | null
  color: string | null
  rows: DatabaseRow[]
  /** Rows matching the view filter and search, not only the loaded ones. */
  count: number
  hasMore: boolean
  status: "loading" | "ready" | "loadingMore" | "error"
  error: string | null
}

export interface UseBoardLanesOptions {
  databaseId: string
  /** The Select/Status property the board groups by; `null` disables the hook. */
  groupPropertyId: string | null
  options: DatabaseOptionSummary[]
  filter?: DatabaseFilterNode
  sorts?: DatabaseSortSpec[]
  search?: string
  /** The page the board is shown on, for `@currentPage` filters. */
  contextPageId?: string
  enabled: boolean
}

interface LaneData {
  rows: DatabaseRow[]
  cursor: string | null
  status: BoardLaneState["status"]
  error: string | null
}

function laneCondition(propertyId: string, key: string): DatabaseFilterNode {
  const field = { kind: "property" as const, propertyId }
  return key === EMPTY_BOARD_LANE
    ? { kind: "condition", field, operator: "isEmpty" }
    : { kind: "condition", field, operator: "equals", value: JSON.stringify(key) }
}

function withLane(
  filter: DatabaseFilterNode | undefined,
  propertyId: string,
  key: string,
): DatabaseFilterNode {
  const lane = laneCondition(propertyId, key)
  return filter ? { kind: "group", operator: "and", children: [filter, lane] } : lane
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Board data that does not depend on which rows happen to be loaded: group
 * counts come from one aggregate over the whole view, and every lane pages its
 * own rows. Lanes follow the property's options, then values of removed options,
 * then the no-value lane.
 */
export function useBoardLanes({
  databaseId,
  groupPropertyId,
  options,
  filter,
  sorts,
  search = "",
  contextPageId,
  enabled,
}: UseBoardLanesOptions) {
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [counts, setCounts] = React.useState<Record<string, number>>({})
  const [data, setData] = React.useState<Record<string, LaneData>>({})
  const [status, setStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [retryTick, setRetryTick] = React.useState(0)
  const token = React.useRef(0)
  const stateRef = React.useRef({ counts, data })
  stateRef.current = { counts, data }
  const trimmedSearch = search.trim()
  const identity = JSON.stringify({
    filter: filter ?? null,
    sorts: sorts ?? [],
    q: trimmedSearch,
    c: contextPageId ?? null,
  })

  const querySorts = React.useCallback(
    () => (sorts?.length ? sorts : undefined),
    // `identity` already stands for the sorts' content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity],
  )

  const fetchLane = React.useCallback(
    (propertyId: string, generationValue: number, key: string, cursor: string | null) =>
      queryDatabase({
        expectedGeneration: generationValue,
        databaseId,
        search: trimmedSearch || undefined,
        sorts: querySorts(),
        filter: withLane(filter, propertyId, key),
        source: {
          kind: "inline",
          spec: {
            sorts: [{ field: { kind: "system", field: "title" }, direction: "asc", nulls: "last" }],
          },
        },
        page: { limit: LANE_PAGE_SIZE, cursor: cursor ?? undefined },
        contextPageId,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextPageId, databaseId, identity, querySorts, trimmedSearch],
  )

  React.useEffect(() => {
    if (!enabled || !groupPropertyId || generation === null) return
    const mine = ++token.current
    setStatus("loading")
    setError(null)
    void (async () => {
      try {
        const aggregate = await aggregateDatabase({
          expectedGeneration: generation,
          databaseId,
          source: { kind: "inline", spec: { filter, sorts: [] } },
          category: { kind: "property", propertyId: groupPropertyId },
          aggregation: "count",
          search: trimmedSearch || undefined,
          limit: MAX_GROUPS,
          contextPageId,
        })
        if (mine !== token.current) return
        const nextCounts: Record<string, number> = {}
        for (const group of aggregate.groups) nextCounts[group.key] = group.count
        const keys = new Set([
          ...options.map((option) => option.optionId),
          ...Object.keys(nextCounts),
        ])
        keys.add(EMPTY_BOARD_LANE)
        const loaded = await Promise.all(
          [...keys].map(async (key): Promise<[string, LaneData]> => {
            if (!nextCounts[key])
              return [key, { rows: [], cursor: null, status: "ready", error: null }]
            try {
              const page = await fetchLane(groupPropertyId, generation, key, null)
              return [
                key,
                { rows: page.rows, cursor: page.nextCursor, status: "ready", error: null },
              ]
            } catch (failure) {
              return [key, { rows: [], cursor: null, status: "error", error: message(failure) }]
            }
          }),
        )
        if (mine !== token.current) return
        setCounts(nextCounts)
        setData(Object.fromEntries(loaded))
        setStatus("ready")
      } catch (failure) {
        if (mine !== token.current) return
        setError(message(failure))
        setStatus("error")
      }
    })()
    // Options are part of the schema revision; a changed list reloads the lanes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    generation,
    databaseId,
    groupPropertyId,
    identity,
    invalidationSeq,
    retryTick,
    options,
  ])

  const loadMore = React.useCallback(
    (key: string) => {
      const lane = stateRef.current.data[key]
      if (!enabled || !groupPropertyId || generation === null) return
      if (!lane || !lane.cursor || lane.status !== "ready") return
      const mine = token.current
      setData((current) => ({ ...current, [key]: { ...lane, status: "loadingMore" } }))
      fetchLane(groupPropertyId, generation, key, lane.cursor).then(
        (page) => {
          if (mine !== token.current) return
          setData((current) => {
            const previous = current[key] ?? lane
            const known = new Set(previous.rows.map((row) => row.noteId))
            return {
              ...current,
              [key]: {
                rows: [...previous.rows, ...page.rows.filter((row) => !known.has(row.noteId))],
                cursor: page.nextCursor,
                status: "ready",
                error: null,
              },
            }
          })
        },
        (failure) => {
          if (mine !== token.current) return
          setData((current) => ({
            ...current,
            [key]: { ...(current[key] ?? lane), status: "error", error: message(failure) },
          }))
        },
      )
    },
    [enabled, fetchLane, generation, groupPropertyId],
  )

  /** Moves a card between lanes right away; the caller persists and reloads on failure. */
  const moveLocally = React.useCallback(
    (row: DatabaseRow, fromKey: string, toKey: string) => {
      if (!groupPropertyId || fromKey === toKey) return
      const field = { kind: "property" as const, propertyId: groupPropertyId }
      const [moved] = moveRowToBoardLane([row], row.noteId, field, toKey)
      setData((current) => {
        const from = current[fromKey]
        const to = current[toKey]
        if (!from || !to) return current
        return {
          ...current,
          [fromKey]: {
            ...from,
            rows: from.rows.filter((candidate) => candidate.noteId !== row.noteId),
          },
          [toKey]: {
            ...to,
            rows: [moved, ...to.rows.filter((candidate) => candidate.noteId !== row.noteId)],
          },
        }
      })
      setCounts((current) => ({
        ...current,
        [fromKey]: Math.max(0, (current[fromKey] ?? 1) - 1),
        [toKey]: (current[toKey] ?? 0) + 1,
      }))
    },
    [groupPropertyId],
  )

  const lanes = React.useMemo<BoardLaneState[]>(() => {
    const known = new Set(options.map((option) => option.optionId))
    const extra = Object.keys(data).filter((key) => key !== EMPTY_BOARD_LANE && !known.has(key))
    const describe = (key: string): Pick<BoardLaneState, "label" | "color"> => {
      const option = options.find((candidate) => candidate.optionId === key)
      return { label: option?.name ?? null, color: option ? safeOptionColor(option.color) : null }
    }
    return [...options.map((option) => option.optionId), ...extra, EMPTY_BOARD_LANE].map((key) => {
      const lane = data[key]
      return {
        key,
        ...describe(key),
        rows: lane?.rows ?? [],
        count: counts[key] ?? 0,
        hasMore: Boolean(lane?.cursor),
        status: lane?.status ?? "loading",
        error: lane?.error ?? null,
      }
    })
  }, [counts, data, options])

  return {
    lanes,
    status,
    error,
    loadMore,
    moveLocally,
    reload: () => setRetryTick((tick) => tick + 1),
  }
}

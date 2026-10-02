import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslation } from "react-i18next"
import type { DatabaseFieldRef, DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"
import {
  ALL_BOARD_LANE,
  EMPTY_BOARD_LANE,
  groupBoardRows,
  moveRowToBoardLane,
  type BoardLane as BoardLaneModel,
} from "./board-model"

interface BoardViewProps {
  rows: DatabaseRow[]
  properties?: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields?: string[] | null
  groupField: DatabaseFieldRef | null
  /** Lanes with their own counts and paging; replaces grouping the loaded `rows`. */
  lanes?: BoardLaneModel[]
  onLoadMoreLane?: (laneKey: string) => void
  loading?: boolean
  error?: string | null
  hasNextPage?: boolean
  onLoadNextPage?: () => void
  onRetry?: () => void
  onRowSelect?: (row: DatabaseRow) => void
  onMoveRow?: (row: DatabaseRow, laneKey: string) => Promise<void>
}

export function BoardView({
  rows,
  properties = [],
  relationTitles,
  cardFields = null,
  groupField,
  lanes: providedLanes,
  onLoadMoreLane,
  loading = false,
  error = null,
  hasNextPage = false,
  onLoadNextPage,
  onRetry,
  onRowSelect,
  onMoveRow,
}: BoardViewProps) {
  const { t } = useTranslation()
  const [optimisticRows, setOptimisticRows] = React.useState(rows)
  const [pending, setPending] = React.useState<Set<string>>(new Set())
  const draggedNoteId = React.useRef<string | null>(null)
  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)
  const lanes = providedLanes ?? groupBoardRows(optimisticRows, groupField, properties)

  React.useEffect(() => {
    if (!loading) nextPagePendingRef.current = false
  }, [loading])

  React.useEffect(() => {
    if (pending.size === 0) setOptimisticRows(rows)
  }, [pending.size, rows])

  const moveRow = React.useCallback(
    async (row: DatabaseRow, laneKey: string) => {
      if (!onMoveRow || !groupField || groupField.kind !== "property" || pending.has(row.noteId))
        return
      setOptimisticRows((current) => moveRowToBoardLane(current, row.noteId, groupField, laneKey))
      setPending((current) => new Set(current).add(row.noteId))
      try {
        await onMoveRow(row, laneKey)
      } catch {
        setOptimisticRows(rows)
      } finally {
        setPending((current) => {
          const next = new Set(current)
          next.delete(row.noteId)
          return next
        })
      }
    },
    [groupField, onMoveRow, pending, rows],
  )

  const handleDropToLane = (noteId: string, laneKey: string) => {
    draggedNoteId.current = null
    const row = optimisticRows.find((candidate) => candidate.noteId === noteId)
    if (row) void moveRow(row, laneKey)
  }

  function laneLabel(lane: BoardLaneModel) {
    if (lane.key === EMPTY_BOARD_LANE) return t("databaseBoard.empty")
    if (lane.key === ALL_BOARD_LANE) return t("databaseBoard.noGroup")
    return lane.label ?? t("databaseValue.unknownOption")
  }

  function handleDrop(event: React.DragEvent, laneKey: string) {
    event.preventDefault()
    const noteId = draggedNoteId.current
    if (noteId) {
      handleDropToLane(noteId, laneKey)
    }
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    const now = Date.now()
    if (
      hasNextPage &&
      !loading &&
      !nextPagePendingRef.current &&
      now - lastPageTriggerRef.current >= 350 &&
      element.scrollWidth > element.clientWidth &&
      element.scrollLeft > 0 &&
      element.scrollLeft + element.clientWidth >= element.scrollWidth - 240
    ) {
      nextPagePendingRef.current = true
      lastPageTriggerRef.current = now
      onLoadNextPage?.()
    }
  }

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden p-4"
      onScroll={handleScroll}
    >
      <div className="flex h-full min-w-full gap-3">
        {lanes.map((lane, index) => (
          <BoardLane
            key={lane.key}
            laneKey={lane.key}
            label={laneLabel(lane)}
            color={lane.color}
            rows={lane.rows}
            index={index}
            laneCount={lanes.length}
            pending={pending}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={cardFields}
            groupPropertyId={groupField?.kind === "property" ? groupField.propertyId : null}
            onDragStart={(row) => {
              draggedNoteId.current = row.noteId
            }}
            onDrop={(event) => handleDrop(event, lane.key)}
            onMoveRow={moveRow}
            onRowSelect={onRowSelect}
            count={lane.count ?? lane.rows.length}
            loading={providedLanes ? lane.status === "loadingMore" : loading}
            hasNextPage={providedLanes ? Boolean(lane.hasMore) : hasNextPage}
            onLoadNextPage={providedLanes ? () => onLoadMoreLane?.(lane.key) : onLoadNextPage}
          />
        ))}
      </div>
      {(loading || error) && (
        <div
          role={error ? "alert" : undefined}
          className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <span>{error ?? t("databaseTable.loading")}</span>
          {error && (
            <button type="button" className="underline" onClick={onRetry}>
              {t("databaseTable.retry")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface BoardLaneProps {
  laneKey: string
  label: string
  color: string | null
  rows: DatabaseRow[]
  index: number
  laneCount: number
  pending: Set<string>
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields: string[] | null
  groupPropertyId: string | null
  onDragStart: (row: DatabaseRow) => void
  onDrop: (event: React.DragEvent) => void
  onMoveRow: (row: DatabaseRow, laneKey: string) => Promise<void>
  onRowSelect?: (row: DatabaseRow) => void
  count: number
  loading: boolean
  hasNextPage: boolean
  onLoadNextPage?: () => void
}

function BoardLane({
  laneKey,
  label,
  color,
  rows,
  index,
  laneCount,
  pending,
  properties,
  relationTitles,
  cardFields,
  groupPropertyId,
  onDragStart,
  onDrop,
  onMoveRow,
  onRowSelect,
  count,
  loading,
  hasNextPage,
  onLoadNextPage,
}: BoardLaneProps) {
  const { t } = useTranslation()
  const parentRef = React.useRef<HTMLDivElement>(null)
  const laneNextPagePendingRef = React.useRef(false)
  const lastLanePageTriggerRef = React.useRef(0)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 5,
  })

  React.useEffect(() => {
    if (!loading) laneNextPagePendingRef.current = false
  }, [loading])

  return (
    <section
      aria-label={label}
      className="flex h-full w-72 shrink-0 flex-col rounded-xl border border-border/70 bg-muted/20"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2 text-xs font-semibold">
        {color && (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 font-normal text-muted-foreground">{count}</span>
      </header>
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onScroll={(event) => {
          const element = event.currentTarget
          const now = Date.now()
          if (
            hasNextPage &&
            !loading &&
            !laneNextPagePendingRef.current &&
            now - lastLanePageTriggerRef.current >= 350 &&
            element.scrollHeight > element.clientHeight &&
            element.scrollTop > 0 &&
            element.scrollTop + element.clientHeight >= element.scrollHeight - 240
          ) {
            laneNextPagePendingRef.current = true
            lastLanePageTriggerRef.current = now
            onLoadNextPage?.()
          }
        }}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            const isPending = pending.has(row.noteId)
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 w-full pb-2"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <button
                  type="button"
                  draggable={!isPending}
                  aria-busy={isPending}
                  className="w-full rounded-lg border border-border/70 bg-card px-3 py-3 text-left text-xs shadow-sm hover:bg-accent/40 disabled:opacity-60"
                  disabled={isPending}
                  onDragStart={() => onDragStart(row)}
                  onClick={() => onRowSelect?.(row)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                    const targetIndex = index + (event.key === "ArrowLeft" ? -1 : 1)
                    if (targetIndex < 0 || targetIndex >= laneCount || isPending) return
                    event.preventDefault()
                    const target = document.querySelector<HTMLElement>(
                      `[data-board-lane-index="${targetIndex}"]`,
                    )
                    const targetKey = target?.dataset.boardLaneKey
                    if (targetKey) void onMoveRow(row, targetKey)
                  }}
                >
                  <span className="block truncate font-medium">{row.title}</span>
                  <DatabaseValueCell
                    row={row}
                    properties={properties}
                    relationTitles={relationTitles}
                    fields={cardFields}
                    exclude={groupPropertyId ? [groupPropertyId] : undefined}
                  />
                </button>
              </div>
            )
          })}
        </div>
        {rows.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">{t("databaseBoard.emptyLane")}</p>
        )}
      </div>
      <div className="sr-only" data-board-lane-index={index} data-board-lane-key={laneKey} />
    </section>
  )
}

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslation } from "react-i18next"
import type { DatabaseFieldRef, DatabaseRow } from "@/lib/storage"
import { ALL_BOARD_LANE, EMPTY_BOARD_LANE, groupBoardRows, moveRowToBoardLane } from "./board-model"

interface BoardViewProps {
  rows: DatabaseRow[]
  groupField: DatabaseFieldRef | null
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
  groupField,
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
  const lanes = groupBoardRows(optimisticRows, groupField)

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

  function laneLabel(key: string) {
    if (key === EMPTY_BOARD_LANE) return t("databaseBoard.empty")
    if (key === ALL_BOARD_LANE) return t("databaseBoard.noGroup")
    return key
  }

  function handleDrop(event: React.DragEvent, laneKey: string) {
    event.preventDefault()
    const noteId = draggedNoteId.current
    draggedNoteId.current = null
    const row = optimisticRows.find((candidate) => candidate.noteId === noteId)
    if (row) void moveRow(row, laneKey)
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    if (
      hasNextPage &&
      !loading &&
      element.scrollLeft + element.clientWidth >= element.scrollWidth - 360
    ) {
      onLoadNextPage?.()
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4" onScroll={handleScroll}>
      <div className="flex h-full min-w-full gap-3">
        {lanes.map((lane, index) => (
          <BoardLane
            key={lane.key}
            laneKey={lane.key}
            label={laneLabel(lane.key)}
            rows={lane.rows}
            index={index}
            laneCount={lanes.length}
            pending={pending}
            onDragStart={(row) => {
              draggedNoteId.current = row.noteId
            }}
            onDrop={(event) => handleDrop(event, lane.key)}
            onMoveRow={moveRow}
            onRowSelect={onRowSelect}
            loading={loading}
            hasNextPage={hasNextPage}
            onLoadNextPage={onLoadNextPage}
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
  rows: DatabaseRow[]
  index: number
  laneCount: number
  pending: Set<string>
  onDragStart: (row: DatabaseRow) => void
  onDrop: (event: React.DragEvent) => void
  onMoveRow: (row: DatabaseRow, laneKey: string) => Promise<void>
  onRowSelect?: (row: DatabaseRow) => void
  loading: boolean
  hasNextPage: boolean
  onLoadNextPage?: () => void
}

function BoardLane({
  laneKey,
  label,
  rows,
  index,
  laneCount,
  pending,
  onDragStart,
  onDrop,
  onMoveRow,
  onRowSelect,
  loading,
  hasNextPage,
  onLoadNextPage,
}: BoardLaneProps) {
  const { t } = useTranslation()
  const parentRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 74,
    overscan: 5,
  })

  return (
    <section
      aria-label={label}
      className="flex h-full w-72 shrink-0 flex-col rounded-xl border border-border/70 bg-muted/20"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="border-b border-border/70 px-3 py-2 text-xs font-semibold">{label}</header>
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onScroll={(event) => {
          const element = event.currentTarget
          if (
            hasNextPage &&
            !loading &&
            element.scrollTop + element.clientHeight >= element.scrollHeight - 240
          ) {
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
                  <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                    {row.relativePath}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
        {rows.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">{t("databaseBoard.empty")}</p>
        )}
      </div>
      <div className="sr-only" data-board-lane-index={index} data-board-lane-key={laneKey} />
    </section>
  )
}

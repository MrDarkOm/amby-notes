import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabaseFieldRef, DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { cardSpring } from "../database-motion"
import type { CardCellEdit } from "../database-value-cell"
import { PageIcon } from "../page-icon"
import { BoardCard } from "./board-card"
import { LaneColorMenu } from "./lane-color-menu"
import { useOptionActions } from "../option-actions"
import { useBoardDrag, type BoardDrag } from "./use-board-drag"
import { cn } from "@/lib/utils"
import {
  ALL_BOARD_LANE,
  EMPTY_BOARD_LANE,
  arrangeLanes,
  groupBoardRows,
  moveRowToBoardLane,
  type GroupDisplay,
  type BoardLane as BoardLaneModel,
} from "./board-model"

interface BoardViewProps {
  rows: DatabaseRow[]
  properties?: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields?: string[] | null
  cardEdit?: CardCellEdit
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
  /** Adds a page to a lane: the button under its cards. Absent when none can be added. */
  onCreateCard?: (laneKey: string) => void
  /** Tint each column with its option's colour (a view setting, off unless chosen). */
  colorColumns?: boolean
  /** Which columns show and in what order (view settings); all, in schema order, when absent. */
  groupDisplay?: GroupDisplay
}

export function BoardView({
  rows,
  properties = [],
  relationTitles,
  cardFields = null,
  cardEdit,
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
  onCreateCard,
  colorColumns = false,
  groupDisplay,
}: BoardViewProps) {
  const { t } = useTranslation()
  const [optimisticRows, setOptimisticRows] = React.useState(rows)
  const [pending, setPending] = React.useState<Set<string>>(new Set())
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)
  const naturalLanes = providedLanes ?? groupBoardRows(optimisticRows, groupField, properties)
  const lanes = React.useMemo(
    () => (groupDisplay ? arrangeLanes(naturalLanes, groupDisplay) : naturalLanes),
    [groupDisplay, naturalLanes],
  )

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

  const { drag, begin, consumeClick } = useBoardDrag({
    scrollRef,
    onDrop: (row, laneKey) => void moveRow(row, laneKey),
  })

  function laneLabel(lane: BoardLaneModel) {
    if (lane.key === EMPTY_BOARD_LANE) return t("databaseBoard.empty")
    if (lane.key === ALL_BOARD_LANE) return t("databaseBoard.noGroup")
    return lane.label ?? t("databaseValue.unknownOption")
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
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden p-5"
      onScroll={handleScroll}
    >
      <div className="flex h-full min-w-full gap-4">
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
            cardEdit={cardEdit}
            groupPropertyId={groupField?.kind === "property" ? groupField.propertyId : null}
            drag={drag}
            onCardPointerDown={begin}
            consumeClick={consumeClick}
            onMoveRow={moveRow}
            onRowSelect={onRowSelect}
            onCreateCard={onCreateCard}
            colorColumns={colorColumns}
            count={lane.count ?? lane.rows.length}
            loading={providedLanes ? lane.status === "loadingMore" : loading}
            hasNextPage={providedLanes ? Boolean(lane.hasMore) : hasNextPage}
            onLoadNextPage={providedLanes ? () => onLoadMoreLane?.(lane.key) : onLoadNextPage}
          />
        ))}
      </div>
      {drag &&
        createPortal(
          <motion.div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[200] rounded-xl border border-primary/50 bg-card px-3 py-2.5 text-xs shadow-2xl"
            initial={{ scale: 1, rotate: 0 }}
            animate={{ scale: 1.04, rotate: 2 }}
            transition={motionTransition(cardSpring)}
            style={{ width: drag.width, x: drag.x - drag.offsetX, y: drag.y - drag.offsetY }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <PageIcon noteId={drag.row.noteId} />
              <span className="truncate font-medium">{drag.row.title}</span>
            </span>
          </motion.div>,
          document.body,
        )}
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
  cardEdit?: CardCellEdit
  groupPropertyId: string | null
  drag: BoardDrag | null
  onCardPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    row: DatabaseRow,
    laneKey: string,
  ) => void
  consumeClick: () => boolean
  onMoveRow: (row: DatabaseRow, laneKey: string) => Promise<void>
  onRowSelect?: (row: DatabaseRow) => void
  onCreateCard?: (laneKey: string) => void
  colorColumns: boolean
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
  cardEdit,
  groupPropertyId,
  drag,
  onCardPointerDown,
  consumeClick,
  onMoveRow,
  onRowSelect,
  onCreateCard,
  colorColumns,
  count,
  loading,
  hasNextPage,
  onLoadNextPage,
}: BoardLaneProps) {
  const { t } = useTranslation()
  // The colour is the option's own; the column shows it only when the view asks for it.
  const tint = colorColumns ? color : null
  // Only a column that stands for a stored option has a colour to change (and only where
  // the schema can be edited: not in a view embedded in a note).
  const optionActions = useOptionActions()
  const recolor =
    colorColumns &&
    optionActions?.setOptionColor &&
    groupPropertyId &&
    laneKey !== EMPTY_BOARD_LANE &&
    laneKey !== ALL_BOARD_LANE
      ? (hex: string) => void optionActions.setOptionColor?.(groupPropertyId, laneKey, hex)
      : null
  // A card held over a lane other than its own: the lane shows where it would land.
  const dropTarget = drag !== null && drag.overLane === laneKey && drag.sourceLane !== laneKey
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
    <motion.section
      aria-label={label}
      data-lane-drop={laneKey}
      className={cn(
        "group/lane flex h-full w-72 shrink-0 flex-col rounded-2xl",
        !tint && "bg-muted/40",
        dropTarget && "bg-primary/10 ring-2 ring-primary/30",
      )}
      // The column takes a light tint of its option's colour.
      style={
        tint && !dropTarget
          ? { backgroundColor: `color-mix(in srgb, ${tint} 12%, transparent)` }
          : undefined
      }
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, scale: dropTarget ? 1.012 : 1 }}
      transition={motionTransition({
        default: cardSpring,
        opacity: { ...motionTransitions.enter, delay: Math.min(index, 8) * 0.04 },
        y: { ...cardSpring, delay: Math.min(index, 8) * 0.04 },
      })}
    >
      <header className="flex items-center gap-2 px-3.5 pb-1.5 pt-3 text-xs font-semibold">
        {color && (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="truncate">{label}</span>
        <span className="shrink-0 rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
        {recolor && (
          <span className="ml-auto">
            <LaneColorMenu color={color} onChange={(hex) => recolor(hex)} />
          </span>
        )}
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
                key={row.noteId}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 w-full pb-2"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <BoardCard
                  row={row}
                  laneKey={laneKey}
                  laneIndex={index}
                  laneCount={laneCount}
                  pending={isPending}
                  dragging={drag?.row.noteId === row.noteId}
                  enterIndex={virtualRow.index}
                  properties={properties}
                  relationTitles={relationTitles}
                  cardFields={cardFields}
                  cardEdit={cardEdit}
                  groupPropertyId={groupPropertyId}
                  onPointerDown={onCardPointerDown}
                  consumeClick={consumeClick}
                  onMoveRow={onMoveRow}
                  onRowSelect={onRowSelect}
                />
              </div>
            )
          })}
        </div>
        <AnimatePresence initial={false}>
          {dropTarget && (
            <motion.div
              key="drop-placeholder"
              aria-hidden="true"
              className="flex items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-primary/50 bg-primary/5 text-xs text-primary"
              initial={{ height: 0, opacity: 0, marginTop: 0 }}
              animate={{ height: 56, opacity: 1, marginTop: 4 }}
              exit={{ height: 0, opacity: 0, marginTop: 0 }}
              transition={motionTransition(cardSpring)}
            >
              {t("databaseBoard.dropHere")}
            </motion.div>
          )}
        </AnimatePresence>
        {onCreateCard && (
          <button
            type="button"
            onClick={() => onCreateCard(laneKey)}
            // A quiet dashed card right under the last card, in the lane's own colour.
            className="mt-1 flex h-10 w-full items-center gap-2 rounded-xl border border-dashed px-3 text-sm text-muted-foreground outline-none hover:bg-background/60 focus-visible:ring-1 focus-visible:ring-ring"
            style={
              tint
                ? { color: tint, borderColor: `color-mix(in srgb, ${tint} 45%, transparent)` }
                : undefined
            }
          >
            <Plus className="size-4" />
            {t("databaseWorkspace.newPage")}
          </button>
        )}
        {rows.length === 0 && !dropTarget && !onCreateCard && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("databaseBoard.emptyLane")}
          </p>
        )}
      </div>
      <div className="sr-only" data-board-lane-index={index} data-board-lane-key={laneKey} />
    </motion.section>
  )
}

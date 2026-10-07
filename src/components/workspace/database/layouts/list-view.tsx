import * as React from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell, type CardCellEdit } from "../database-value-cell"
import { CardSurface } from "./card-surface"
import { PageIcon } from "../page-icon"
import { RowGrab, type RowMenuModel } from "../row-menu"
import { useRowContextMenu } from "../use-row-context-menu"
import type { RowReorderConfig } from "../table-view"
import { listColumns } from "./list-columns"
import { dragShift, dragTarget } from "../row-drag-layout"
import { useRowReorder } from "./use-row-reorder"

interface ListViewProps {
  rows: DatabaseRow[]
  properties?: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields?: string[] | null
  cardEdit?: CardCellEdit
  loading?: boolean
  error?: string | null
  hasNextPage?: boolean
  onLoadNextPage?: () => void
  onRetry?: () => void
  onRowSelect?: (row: DatabaseRow) => void
  /** Adds a page: the row under the list, like the table's. Absent when none can be added. */
  onCreateCard?: () => void
  /** What the grip of a row can do; without it rows have no grip. */
  rowMenu?: (row: DatabaseRow) => RowMenuModel
  /** Rows can be placed by hand: absent or `enabled: false` leaves the grip as a menu button. */
  rowReorder?: RowReorderConfig
}

export function ListView({
  rows,
  properties = [],
  relationTitles,
  cardFields = null,
  cardEdit,
  loading = false,
  error = null,
  hasNextPage = false,
  onLoadNextPage,
  onRetry,
  onRowSelect,
  onCreateCard,
  rowMenu,
  rowReorder,
}: ListViewProps) {
  const { t } = useTranslation()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const contextMenu = useRowContextMenu({ rows, rowMenu })
  // The rows slide while one is lifted, so the pointer is matched against where they were when
  // it was picked up (the list is not virtualized: every row is there to measure).
  const slotsRef = React.useRef<Array<{ top: number; height: number }> | null>(null)
  const rowIdsRef = React.useRef<string[]>([])
  rowIdsRef.current = rows.map((row) => row.noteId)
  const reorder = useRowReorder({
    scrollRef,
    axis: "list",
    onDrop: (rowId, overId, placement) => rowReorder?.onReorder(rowId, overId, placement),
    hitTest: (_x, y, rowId) => {
      const area = scrollRef.current
      const slots = slotsRef.current
      if (!area || !slots) return null
      const py = y - area.getBoundingClientRect().top + area.scrollTop
      let best = slots.findIndex((slot) => py >= slot.top && py < slot.top + slot.height)
      if (best === -1) best = py < (slots[0]?.top ?? 0) ? 0 : slots.length - 1
      return dragTarget(rowIdsRef.current, rowId, best)
    },
  })
  const dragging = reorder.drag !== null
  const everDragged = React.useRef(false)
  if (dragging) everDragged.current = true
  React.useLayoutEffect(() => {
    if (!dragging) {
      slotsRef.current = null
      return
    }
    const area = scrollRef.current
    if (!area || slotsRef.current) return
    const top = area.getBoundingClientRect().top
    slotsRef.current = Array.from(area.querySelectorAll<HTMLElement>("[data-reorder-id]")).map(
      (element) => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top - top + area.scrollTop, height: rect.height }
      },
    )
  }, [dragging])
  const dragFrom = reorder.drag ? rows.findIndex((r) => r.noteId === reorder.drag?.rowId) : -1
  const dragTo = reorder.drag?.overId
    ? rows.findIndex((r) => r.noteId === reorder.drag?.overId)
    : dragFrom
  const rowShift = (index: number) => {
    if (!everDragged.current) return undefined
    if (dragFrom === -1) return { y: 0, instant: true }
    const step = slotsRef.current?.[dragFrom]?.height ?? 0
    return {
      y: dragShift({
        index,
        from: dragFrom,
        to: dragTo,
        count: rows.length,
        step,
        pointerDelta: reorder.drag
          ? reorder.drag.y - reorder.drag.startY + reorder.drag.scrollDelta
          : 0,
      }),
      instant: index === dragFrom,
    }
  }
  const columns = React.useMemo(
    () => listColumns(rows, properties, cardFields),
    [cardFields, properties, rows],
  )
  // Rows are indented by how deep they sit below the shallowest loaded row, so a list whose
  // records all live one level down does not start with an empty margin.
  const baseDepth = React.useMemo(
    () => rows.reduce((least, row) => Math.min(least, row.depth), Number.POSITIVE_INFINITY),
    [rows],
  )
  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)

  React.useEffect(() => {
    if (!loading) nextPagePendingRef.current = false
  }, [loading])

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    const now = Date.now()
    if (
      hasNextPage &&
      !loading &&
      !nextPagePendingRef.current &&
      now - lastPageTriggerRef.current >= 350 &&
      element.scrollHeight > element.clientHeight &&
      element.scrollTop > 0 &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 240
    ) {
      nextPagePendingRef.current = true
      lastPageTriggerRef.current = now
      onLoadNextPage?.()
    }
  }

  return (
    // The list reaches into the margin on the left, where the grips hang.
    <div className="relative -ml-7 flex min-h-0 min-w-0 flex-1">
      <div
        ref={scrollRef}
        // The grips sit left of the rows, in this margin.
        className={cn("min-h-0 min-w-0 flex-1 overflow-auto py-1", rowMenu && "pl-7")}
        onScroll={handleScroll}
      >
        <div
          role="list"
          className="grid w-full items-center"
          // The title takes what is left; each property gets a column as wide as its widest value
          // (up to a limit), so values of every row line up and stay close together.
          style={{
            gridTemplateColumns: `minmax(0, 1fr) repeat(${columns.length}, fit-content(14rem))`,
            columnGap: "0.75rem",
          }}
        >
          {rows.map((row, index) => (
            <CardSurface
              key={row.noteId}
              enterIndex={index}
              shift={rowShift(index)}
              role="listitem"
              data-reorder-id={row.noteId}
              className={cn(
                "group/row relative col-span-full grid min-h-10 cursor-pointer grid-cols-subgrid items-center gap-x-3 rounded-lg px-2 py-1 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring",
                index === dragFrom && "database-row-lifted",
              )}
              onOpen={() => onRowSelect?.(row)}
              onContextMenu={(event) => contextMenu.open(event, row)}
            >
              {rowMenu && (
                <RowGrab
                  row={row}
                  menu={rowMenu(row)}
                  reorderEnabled={Boolean(rowReorder?.enabled)}
                  onPress={reorder.begin}
                  onNudge={
                    rowReorder?.onNudge
                      ? (offset) => rowReorder.onNudge?.(row.noteId, offset)
                      : undefined
                  }
                  onBlockedDrag={rowReorder?.onBlockedDrag}
                  className="absolute -left-6 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                />
              )}
              <span
                className="amby-density-inline-padding-left flex min-w-0 flex-1 items-baseline gap-2"
                style={
                  {
                    paddingLeft: (row.depth - baseDepth) * 16,
                    "--amby-density-padding-left": `${(row.depth - baseDepth) * 16}px`,
                  } as React.CSSProperties
                }
              >
                <PageIcon noteId={row.noteId} className="size-4 self-center" />
                <span className="truncate text-sm font-medium">{row.title}</span>
                {row.categoryPath.length > 0 && (
                  <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground sm:inline">
                    {row.categoryPath.join(" / ")}
                  </span>
                )}
              </span>
              <DatabaseValueCell
                row={row}
                properties={properties}
                relationTitles={relationTitles}
                fields={columns}
                edit={cardEdit}
                inline
              />
            </CardSurface>
          ))}
          {onCreateCard && !loading && (
            <div className="col-span-full flex items-center px-2 py-1.5">
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={onCreateCard}
              >
                <Plus className="size-3.5" />
                <span>{t("databaseWorkspace.newPage")}</span>
              </button>
            </div>
          )}
          <div className="col-span-full">
            <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
          </div>
        </div>
        {contextMenu.element}
      </div>
    </div>
  )
}

function LayoutStatus({
  loading,
  error,
  onRetry,
}: Pick<ListViewProps, "loading" | "error" | "onRetry">) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">{t("databaseTable.loading")}</p>
    )
  }
  if (!error) return null
  return (
    <div
      role="alert"
      className="flex items-center justify-center gap-2 py-4 text-xs text-destructive"
    >
      <span>{error}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t("databaseTable.retry")}
      </Button>
    </div>
  )
}

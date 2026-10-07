import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { useTranslation } from "react-i18next"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"
import type { CardSize } from "../view-config"
import { CardEditToggle } from "./card-edit-toggle"
import { useCardActive } from "./use-card-active"
import { CardSurface } from "./card-surface"
import { CardTitleInput } from "./card-title-input"
import { PageIcon } from "../page-icon"
import { cn } from "@/lib/utils"
import type { CardCellEdit } from "../database-value-cell"
import type { createCoverResolver } from "./cover-resolver"
import { useCoverResolver } from "./use-cover-resolver"
import { GalleryCover } from "./gallery-cover"
import { resolveGalleryPreview } from "./gallery-preview"
import type { RowReorderConfig } from "../table-view"
import { RowDragGhost } from "./row-drag-ghost"
import type { RowMenuModel } from "../row-menu"
import { useRowContextMenu } from "../use-row-context-menu"
import { useRowReorder, watchBlockedDrag } from "./use-row-reorder"

const CREATE_TILE = Symbol("create-tile")
/** The empty place a dragged card would land in; the other cards make room for it. */
const DROP_ZONE = Symbol("drop-zone")

/** Where a card sat when it was picked up, in the scrolling area's own coordinates. */
interface Slot {
  id: string
  left: number
  top: number
  width: number
  height: number
}

const GALLERY_CARD_WIDTH: Record<CardSize, number> = { small: 170, medium: 220, large: 320 }
const GALLERY_CARD_HEIGHT: Record<CardSize, number> = { small: 190, medium: 240, large: 330 }

/** A card without a cover is only as tall as its title and properties. */
const GALLERY_CARD_HEIGHT_NO_COVER = 120

interface GalleryViewProps {
  rows: DatabaseRow[]
  properties?: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  databaseId?: string
  cardFields?: string[] | null
  cardEdit?: CardCellEdit
  cardSize?: CardSize
  /** Show the cover image at the top of each card. */
  coverVisible?: boolean
  vaultGeneration?: number | null
  loading?: boolean
  error?: string | null
  hasNextPage?: boolean
  onLoadNextPage?: () => void
  onRetry?: () => void
  onRowSelect?: (row: DatabaseRow) => void
  /** Adds a page: the button under the cards. Absent when the database cannot take one. */
  onCreateCard?: () => void
  /** Cards can be placed by hand: absent or `enabled: false` leaves them where they are. */
  rowReorder?: RowReorderConfig
  /** The menu of a card on a right click; absent leaves the browser's own. */
  rowMenu?: (row: DatabaseRow) => RowMenuModel
}

/** What a card needs to be picked up. */
interface CardReorder {
  enabled: boolean
  begin: ReturnType<typeof useRowReorder>["begin"]
  consumeClick: () => boolean
  onBlockedDrag?: () => void
}

export function GalleryView({
  rows,
  properties = [],
  relationTitles,
  databaseId,
  cardFields = null,
  cardEdit,
  cardSize = "medium",
  coverVisible = true,
  vaultGeneration = null,
  loading = false,
  error = null,
  hasNextPage = false,
  onLoadNextPage,
  onRetry,
  onRowSelect,
  onCreateCard,
  rowReorder,
  rowMenu,
}: GalleryViewProps) {
  const { t } = useTranslation()
  const parentRef = React.useRef<HTMLDivElement>(null)
  // The cards move aside while one is dragged, so the pointer is matched against where they were
  // when it was picked up, never against the moving cards.
  const slotsRef = React.useRef<Slot[] | null>(null)
  const hitTest = React.useCallback((x: number, y: number, rowId: string) => {
    const area = parentRef.current
    const slots = slotsRef.current
    if (!area || !slots) return null
    const bounds = area.getBoundingClientRect()
    const px = x - bounds.left + area.scrollLeft
    const py = y - bounds.top + area.scrollTop
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    slots.forEach((slot, index) => {
      const dx = Math.max(slot.left - px, 0, px - (slot.left + slot.width))
      const dy = Math.max(slot.top - py, 0, py - (slot.top + slot.height))
      const distance = Math.hypot(dx, dy)
      if (distance < bestDistance) {
        best = index
        bestDistance = distance
      }
    })
    if (best === -1) return null
    const from = slots.findIndex((slot) => slot.id === rowId)
    return {
      overId: slots[best].id,
      placement: best > from ? ("after" as const) : ("before" as const),
    }
  }, [])
  const reorder = useRowReorder({
    scrollRef: parentRef,
    axis: "grid",
    onDrop: (rowId, overId, placement) => rowReorder?.onReorder(rowId, overId, placement),
    hitTest,
  })
  const contextMenu = useRowContextMenu({ rows, rowMenu })
  const cardReorder: CardReorder = {
    enabled: Boolean(rowReorder?.enabled),
    begin: reorder.begin,
    consumeClick: reorder.consumeClick,
    onBlockedDrag: rowReorder?.onBlockedDrag,
  }
  const dragging = reorder.drag !== null
  const draggedId = reorder.drag?.rowId ?? null
  const overId = reorder.drag?.overId ?? null
  // Cards that were already on screen must not fade in again when the view returns to normal.
  const everDragged = React.useRef(false)
  if (dragging) everDragged.current = true
  const coverResolver = useCoverResolver(databaseId, vaultGeneration)
  const [columnCount, setColumnCount] = React.useState(1)

  React.useLayoutEffect(() => {
    const element = parentRef.current
    if (!element) return
    const update = () =>
      setColumnCount(
        Math.max(1, Math.floor((element.clientWidth + 16) / GALLERY_CARD_WIDTH[cardSize])),
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [cardSize])

  // The "new page" tile is the last cell of the grid, a card of its own like in Notion.
  const items = React.useMemo<Array<DatabaseRow | typeof CREATE_TILE>>(
    () => (onCreateCard && !loading ? [...rows, CREATE_TILE] : rows),
    [loading, onCreateCard, rows],
  )
  // While dragging: every card in one plain grid (so they can slide), the dragged one replaced by
  // the drop zone, which sits where the card would land.
  const dragItems = React.useMemo<Array<
    DatabaseRow | typeof DROP_ZONE | typeof CREATE_TILE
  > | null>(() => {
    if (!draggedId) return null
    const from = rows.findIndex((row) => row.noteId === draggedId)
    if (from === -1) return null
    const without = rows.filter((row) => row.noteId !== draggedId)
    const over = overId ? rows.findIndex((row) => row.noteId === overId) : -1
    const list: Array<DatabaseRow | typeof DROP_ZONE | typeof CREATE_TILE> = [...without]
    list.splice(Math.min(over === -1 ? from : over, without.length), 0, DROP_ZONE)
    if (onCreateCard && !loading) list.push(CREATE_TILE)
    return list
  }, [draggedId, loading, onCreateCard, overId, rows])
  React.useLayoutEffect(() => {
    if (!dragging) {
      slotsRef.current = null
      return
    }
    const area = parentRef.current
    if (!area || slotsRef.current) return
    const bounds = area.getBoundingClientRect()
    // The first dragging layout still has the drop zone in the dragged card's own place.
    slotsRef.current = Array.from(area.querySelectorAll<HTMLElement>("[data-slot-id]")).map(
      (element) => {
        const rect = element.getBoundingClientRect()
        return {
          id: element.dataset.slotId ?? "",
          left: rect.left - bounds.left + area.scrollLeft,
          top: rect.top - bounds.top + area.scrollTop,
          width: rect.width,
          height: rect.height,
        }
      },
    )
  }, [dragging])
  const rowCount = Math.ceil(items.length / columnCount)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () =>
      coverVisible ? GALLERY_CARD_HEIGHT[cardSize] : GALLERY_CARD_HEIGHT_NO_COVER,
    overscan: 4,
  })

  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)

  React.useEffect(() => {
    if (!loading) nextPagePendingRef.current = false
  }, [loading])

  function handleScroll() {
    const element = parentRef.current
    const now = Date.now()
    if (
      element &&
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
    <div
      ref={parentRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto p-5"
      onScroll={handleScroll}
    >
      {dragItems ? (
        <div
          className="grid gap-4 pb-4"
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {dragItems.map((item) =>
            item === DROP_ZONE ? (
              <motion.div
                key="drop-zone"
                layout
                aria-hidden="true"
                data-slot-id={draggedId ?? undefined}
                className="min-h-36 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5"
                transition={{ layout: motionTransition(motionTransitions.reorder) }}
              />
            ) : item === CREATE_TILE ? (
              <button
                key="create-card"
                type="button"
                onClick={onCreateCard}
                className="flex min-h-[5.5rem] items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card text-sm text-muted-foreground outline-none"
              >
                <Plus className="size-4" />
                {t("databaseWorkspace.newPage")}
              </button>
            ) : (
              <motion.div
                key={item.noteId}
                layout
                data-slot-id={item.noteId}
                className="flex min-w-0 flex-col [&>*]:flex-1"
                transition={{ layout: motionTransition(motionTransitions.reorder) }}
              >
                <GalleryCard
                  row={item}
                  properties={properties}
                  relationTitles={relationTitles}
                  cardFields={cardFields}
                  cardEdit={cardEdit}
                  cardSize={cardSize}
                  coverVisible={coverVisible}
                  coverResolver={coverResolver}
                  onRowSelect={onRowSelect}
                />
              </motion.div>
            ),
          )}
        </div>
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const start = virtualRow.index * columnCount
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 grid w-full gap-4 pb-4"
                style={{
                  gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {items.slice(start, start + columnCount).map((item, offset) =>
                  item === CREATE_TILE ? (
                    <button
                      key="create-card"
                      type="button"
                      onClick={onCreateCard}
                      className="flex min-h-[5.5rem] items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card text-sm text-muted-foreground outline-none hover:bg-accent/30 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <Plus className="size-4" />
                      {t("databaseWorkspace.newPage")}
                    </button>
                  ) : (
                    <GalleryCard
                      key={item.noteId}
                      enterIndex={everDragged.current ? undefined : start + offset}
                      row={item}
                      properties={properties}
                      relationTitles={relationTitles}
                      cardFields={cardFields}
                      cardEdit={cardEdit}
                      cardSize={cardSize}
                      coverVisible={coverVisible}
                      coverResolver={coverResolver}
                      onRowSelect={onRowSelect}
                      reorder={cardReorder}
                      onContextMenu={(event) => contextMenu.open(event, item)}
                    />
                  ),
                )}
              </div>
            )
          })}
        </div>
      )}
      {contextMenu.element}
      <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
      <RowDragGhost
        drag={reorder.drag}
        title={rows.find((row) => row.noteId === reorder.drag?.rowId)?.title ?? ""}
      />
    </div>
  )
}

interface GalleryCardProps {
  row: DatabaseRow
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields: string[] | null
  cardEdit?: CardCellEdit
  cardSize: CardSize
  coverVisible: boolean
  coverResolver: ReturnType<typeof createCoverResolver>
  enterIndex?: number
  onRowSelect?: (row: DatabaseRow) => void
  reorder?: CardReorder
  onContextMenu?: (event: React.MouseEvent) => void
}

/** One gallery card: optional cover, the page icon and title, then its properties. */
export function GalleryCard({
  row,
  properties,
  relationTitles,
  cardFields,
  cardEdit,
  cardSize,
  coverVisible,
  coverResolver,
  enterIndex,
  onRowSelect,
  reorder,
  onContextMenu,
}: GalleryCardProps) {
  const [editing, setEditing] = React.useState(false)
  const { active, activeProps } = useCardActive()
  const preview = coverVisible ? resolveGalleryPreview(row.valuesJson) : null
  return (
    <CardSurface
      {...activeProps}
      lift={!editing}
      enterIndex={enterIndex}
      onContextMenu={onContextMenu}
      onPointerDown={(event) => {
        if (editing || !reorder) return
        if (!reorder.enabled) {
          // A sort decides the order: dragging offers to switch it off.
          if (reorder.onBlockedDrag) watchBlockedDrag(event, reorder.onBlockedDrag)
          return
        }
        reorder.begin(event, row.noteId, { lift: event.currentTarget, skipInteractive: true })
      }}
      className={cn(
        "relative flex min-h-36 flex-col rounded-2xl border bg-card p-3.5 text-left shadow-sm",
        editing
          ? "cursor-default border-primary/40 ring-2 ring-primary/20"
          : "cursor-pointer border-border/60 hover:border-border hover:shadow-md",
      )}
      onOpen={
        editing
          ? undefined
          : () => {
              // The click that ends a drag must not open the card.
              if (reorder?.consumeClick()) return
              onRowSelect?.(row)
            }
      }
    >
      {cardEdit && (
        <CardEditToggle
          editing={editing}
          active={active}
          onToggle={() => setEditing((on) => !on)}
        />
      )}
      <span>
        {preview && <GalleryCover preview={preview} resolver={coverResolver} size={cardSize} />}
        <span className="flex min-w-0 items-center gap-1.5">
          <PageIcon noteId={row.noteId} editable={editing && Boolean(cardEdit)} />
          {editing && cardEdit?.onRename ? (
            <CardTitleInput
              value={row.title}
              className="text-sm font-semibold"
              onCommit={(name) => cardEdit.onRename!(row, name)}
            />
          ) : (
            <span className="truncate pr-6 text-sm font-semibold">{row.title}</span>
          )}
        </span>
        <DatabaseValueCell
          row={row}
          properties={properties}
          relationTitles={relationTitles}
          fields={cardFields}
          edit={editing ? cardEdit : undefined}
        />
      </span>
    </CardSurface>
  )
}

function LayoutStatus({
  loading,
  error,
  onRetry,
}: Pick<GalleryViewProps, "loading" | "error" | "onRetry">) {
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

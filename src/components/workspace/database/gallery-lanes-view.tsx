import * as React from "react"
import { ChevronDown, ChevronRight, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  DatabaseFilterNode,
  DatabasePropertySummary,
  DatabaseRow,
  DatabaseSortSpec,
} from "@/lib/storage"
import type { CardCellEdit } from "./database-value-cell"
import { GalleryCard } from "./layouts/gallery-view"
import { useCoverResolver } from "./layouts/use-cover-resolver"
import { arrangeLanes, EMPTY_BOARD_LANE, type GroupDisplay } from "./layouts/board-model"
import type { CardSize } from "./view-config"
import { useBoardLanes } from "./use-board-lanes"
import { useRowContextMenu } from "./use-row-context-menu"
import type { RowMenuModel } from "./row-menu"

const GALLERY_COLUMN_MIN_WIDTH: Record<CardSize, number> = { small: 170, medium: 220, large: 320 }

interface GalleryLanesViewProps {
  databaseId: string
  groupProperty: DatabasePropertySummary
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields?: string[] | null
  cardEdit?: CardCellEdit
  cardSize?: CardSize
  coverVisible?: boolean
  vaultGeneration?: number | null
  filter?: DatabaseFilterNode
  sorts?: DatabaseSortSpec[]
  search?: string
  contextPageId?: string
  enabled: boolean
  onRowSelect?: (row: DatabaseRow) => void
  rowMenu?: (row: DatabaseRow) => RowMenuModel
  /** Tint each group's heading with its option's colour (a view setting). */
  colorColumns?: boolean
  /** Which groups show and in what order (view settings). */
  groupDisplay?: GroupDisplay
  /** Adds a page to a group; the groups reload when it settles. */
  onCreateCard?: (laneKey: string) => void | Promise<void>
}

/**
 * A gallery grouped by a Select or Status property, like a Notion gallery
 * grouped by "importance": one heading per option with the card count of the
 * whole view, then that group's cards. The groups come from the same lane data
 * as the board (full counts, a page of cards per group), so they do not depend
 * on which rows happen to be loaded.
 */
export function GalleryLanesView({
  databaseId,
  groupProperty,
  properties,
  relationTitles,
  cardFields = null,
  cardEdit,
  cardSize = "medium",
  coverVisible = true,
  vaultGeneration = null,
  filter,
  sorts,
  search,
  contextPageId,
  enabled,
  onRowSelect,
  rowMenu,
  colorColumns = false,
  groupDisplay,
  onCreateCard,
}: GalleryLanesViewProps) {
  const { t } = useTranslation()
  const board = useBoardLanes({
    databaseId,
    groupPropertyId: groupProperty.propertyId,
    options: groupProperty.options,
    filter,
    sorts,
    search,
    contextPageId,
    enabled,
  })
  const coverResolver = useCoverResolver(databaseId, vaultGeneration)
  const [folded, setFolded] = React.useState<Set<string>>(() => new Set())
  const lanes = React.useMemo(
    () => (groupDisplay ? arrangeLanes(board.lanes, groupDisplay) : board.lanes),
    [board.lanes, groupDisplay],
  )
  const allRows = React.useMemo(() => lanes.flatMap((lane) => lane.rows), [lanes])
  const contextMenu = useRowContextMenu({ rows: allRows, rowMenu })
  // A changed property can move a card to another group or out of the filter.
  const groupedEdit = React.useMemo<CardCellEdit | undefined>(
    () =>
      cardEdit && {
        ...cardEdit,
        onCommit: async (row, property, valueJson) => {
          await cardEdit.onCommit(row, property, valueJson)
          board.reload()
        },
        onRename: cardEdit.onRename
          ? async (row, name) => {
              await cardEdit.onRename?.(row, name)
              board.reload()
            }
          : undefined,
      },
    // The groups reload on any change; `board.reload` is rebuilt with the hook's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardEdit],
  )
  const columns = `repeat(auto-fill, minmax(${GALLERY_COLUMN_MIN_WIDTH[cardSize]}px, 1fr))`

  const label = (key: string, name: string | null) =>
    key === EMPTY_BOARD_LANE ? t("databaseBoard.empty") : (name ?? t("databaseValue.unknownOption"))

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto p-5">
      {board.status === "loading" && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {t("databaseTable.loading")}
        </p>
      )}
      {board.error && (
        <div
          role="alert"
          className="flex items-center justify-center gap-2 py-4 text-xs text-destructive"
        >
          <span>{board.error}</span>
          <Button variant="ghost" size="sm" onClick={board.reload}>
            {t("databaseTable.retry")}
          </Button>
        </div>
      )}
      {lanes.map((lane) => {
        const isFolded = folded.has(lane.key)
        return (
          <section key={lane.key} className="mb-6" aria-label={label(lane.key, lane.label)}>
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() =>
                setFolded((current) => {
                  const next = new Set(current)
                  if (next.has(lane.key)) next.delete(lane.key)
                  else next.add(lane.key)
                  return next
                })
              }
              className="mb-3 flex items-center gap-2 text-left"
            >
              {isFolded ? (
                <ChevronRight className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
                  !lane.color && "bg-accent text-foreground",
                )}
                style={
                  lane.color
                    ? colorColumns
                      ? { backgroundColor: `${lane.color}33` }
                      : undefined
                    : undefined
                }
              >
                {lane.color && (
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ backgroundColor: lane.color }}
                  />
                )}
                {label(lane.key, lane.label)}
              </span>
              <span className="text-xs text-muted-foreground">
                {lane.count ?? lane.rows.length}
              </span>
            </button>
            {!isFolded && (
              <>
                <div className="grid gap-4" style={{ gridTemplateColumns: columns }}>
                  {lane.rows.map((row) => (
                    <GalleryCard
                      key={row.noteId}
                      row={row}
                      properties={properties}
                      relationTitles={relationTitles}
                      cardFields={cardFields}
                      cardEdit={groupedEdit}
                      cardSize={cardSize}
                      coverVisible={coverVisible}
                      coverResolver={coverResolver}
                      onRowSelect={onRowSelect}
                      onContextMenu={(event) => contextMenu.open(event, row)}
                    />
                  ))}
                  {onCreateCard && (
                    <button
                      type="button"
                      onClick={() => {
                        void Promise.resolve(onCreateCard(lane.key)).finally(() => board.reload())
                      }}
                      className="flex min-h-[5.5rem] items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card text-sm text-muted-foreground outline-none hover:bg-accent/30 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <Plus className="size-4" />
                      {t("databaseWorkspace.newPage")}
                    </button>
                  )}
                </div>
                {lane.hasMore && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={lane.status === "loadingMore"}
                      onClick={() => board.loadMore(lane.key)}
                    >
                      {t("databaseLinkedView.loadMore")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        )
      })}
      {contextMenu.element}
    </div>
  )
}

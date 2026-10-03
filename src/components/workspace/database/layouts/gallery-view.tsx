import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"
import { resolveDatabaseAssetPaths } from "@/lib/storage"
import type { CardSize } from "../view-config"
import { CardEditToggle } from "./card-edit-toggle"
import { useCardActive } from "./use-card-active"
import { CardSurface } from "./card-surface"
import { CardTitleInput } from "./card-title-input"
import { PageIcon } from "../page-icon"
import { cn } from "@/lib/utils"
import type { CardCellEdit } from "../database-value-cell"
import { createCoverResolver } from "./cover-resolver"
import { GalleryCover } from "./gallery-cover"
import { resolveGalleryPreview } from "./gallery-preview"

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
}: GalleryViewProps) {
  const parentRef = React.useRef<HTMLDivElement>(null)
  const coverResolver = React.useMemo(
    () =>
      createCoverResolver(async (relativePaths) => {
        if (!databaseId || vaultGeneration === null) return relativePaths.map(() => null)
        const result = await resolveDatabaseAssetPaths({
          expectedGeneration: vaultGeneration,
          databaseId,
          relativePaths,
        })
        return result.paths
      }),
    [databaseId, vaultGeneration],
  )
  React.useEffect(() => () => coverResolver.clear(), [coverResolver])
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

  const rowCount = Math.ceil(rows.length / columnCount)
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
              {rows.slice(start, start + columnCount).map((row, offset) => (
                <GalleryCard
                  key={row.noteId}
                  enterIndex={start + offset}
                  row={row}
                  properties={properties}
                  relationTitles={relationTitles}
                  cardFields={cardFields}
                  cardEdit={cardEdit}
                  cardSize={cardSize}
                  coverVisible={coverVisible}
                  coverResolver={coverResolver}
                  onRowSelect={onRowSelect}
                />
              ))}
            </div>
          )
        })}
      </div>
      <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
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
}: GalleryCardProps) {
  const [editing, setEditing] = React.useState(false)
  const { active, activeProps } = useCardActive()
  const preview = coverVisible ? resolveGalleryPreview(row.valuesJson) : null
  return (
    <CardSurface
      {...activeProps}
      lift={!editing}
      enterIndex={enterIndex}
      className={cn(
        "relative flex min-h-36 flex-col rounded-2xl border bg-card p-3.5 text-left shadow-sm",
        editing
          ? "cursor-default border-primary/40 ring-2 ring-primary/20"
          : "cursor-pointer border-border/60 hover:border-border hover:shadow-md",
      )}
      onOpen={editing ? undefined : () => onRowSelect?.(row)}
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

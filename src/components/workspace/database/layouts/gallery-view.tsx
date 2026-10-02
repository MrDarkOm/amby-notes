import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"
import { resolveDatabaseAssetPaths } from "@/lib/storage"
import type { CardSize } from "../view-config"
import { createCoverResolver } from "./cover-resolver"
import { GalleryCover } from "./gallery-cover"
import { resolveGalleryPreview } from "./gallery-preview"

const GALLERY_CARD_WIDTH: Record<CardSize, number> = { small: 170, medium: 220, large: 320 }
const GALLERY_CARD_HEIGHT: Record<CardSize, number> = { small: 190, medium: 240, large: 330 }

interface GalleryViewProps {
  rows: DatabaseRow[]
  properties?: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  databaseId?: string
  cardFields?: string[] | null
  cardSize?: CardSize
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
  cardSize = "medium",
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
        Math.max(1, Math.floor((element.clientWidth + 12) / GALLERY_CARD_WIDTH[cardSize])),
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
    estimateSize: () => GALLERY_CARD_HEIGHT[cardSize],
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
      className="min-h-0 min-w-0 flex-1 overflow-auto p-4"
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
              className="absolute left-0 grid w-full gap-3"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {rows.slice(start, start + columnCount).map((row) => {
                const preview = resolveGalleryPreview(row.valuesJson)
                return (
                  <button
                    key={row.noteId}
                    type="button"
                    className="group flex min-h-36 flex-col rounded-xl border border-border/70 bg-card/60 p-4 text-left hover:border-primary/50 hover:bg-accent/40"
                    onClick={() => onRowSelect?.(row)}
                  >
                    <span>
                      <GalleryCover preview={preview} resolver={coverResolver} size={cardSize} />
                      <span className="block truncate text-sm font-semibold">{row.title}</span>
                      <DatabaseValueCell
                        row={row}
                        properties={properties}
                        relationTitles={relationTitles}
                        fields={cardFields}
                      />
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
    </div>
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

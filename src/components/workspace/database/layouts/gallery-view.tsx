import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"
import { resolveGalleryPreview } from "./gallery-preview"

interface GalleryViewProps {
  rows: DatabaseRow[]
  loading?: boolean
  error?: string | null
  hasNextPage?: boolean
  onLoadNextPage?: () => void
  onRetry?: () => void
  onRowSelect?: (row: DatabaseRow) => void
}

export function GalleryView({
  rows,
  loading = false,
  error = null,
  hasNextPage = false,
  onLoadNextPage,
  onRetry,
  onRowSelect,
}: GalleryViewProps) {
  const parentRef = React.useRef<HTMLDivElement>(null)
  const [columnCount, setColumnCount] = React.useState(1)

  React.useLayoutEffect(() => {
    const element = parentRef.current
    if (!element) return
    const update = () => setColumnCount(Math.max(1, Math.floor((element.clientWidth + 12) / 220)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowCount = Math.ceil(rows.length / columnCount)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 4,
  })

  function handleScroll() {
    const element = parentRef.current
    if (
      element &&
      hasNextPage &&
      !loading &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 360
    ) {
      onLoadNextPage?.()
    }
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto p-4" onScroll={handleScroll}>
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
                    className="group flex min-h-36 flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-4 text-left hover:border-primary/50 hover:bg-accent/40"
                    onClick={() => onRowSelect?.(row)}
                  >
                    <span>
                      <span
                        className={`mb-2 block h-16 rounded-md ${preview.kind === "asset" ? "bg-muted" : "bg-muted/70"}`}
                        aria-hidden="true"
                      />
                      <span className="block truncate text-sm font-semibold">{row.title}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {row.relativePath}
                      </span>
                      <DatabaseValueCell row={row} />
                    </span>
                    <span className="mt-4 truncate font-mono text-[10px] text-muted-foreground">
                      {row.noteId}
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

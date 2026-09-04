import * as React from "react"
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabaseRow } from "@/lib/storage"

const ROW_HEIGHT = 36
const OVERSCAN = 8

interface TableViewProps {
  rows: DatabaseRow[]
  loading: boolean
  error: string | null
  hasNextPage: boolean
  onLoadNextPage: () => void
  onRetry: () => void
  onRowSelect?: (row: DatabaseRow) => void
}

export function TableView({
  rows,
  loading,
  error,
  hasNextPage,
  onLoadNextPage,
  onRetry,
  onRowSelect,
}: TableViewProps) {
  const { t } = useTranslation()
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(480)
  const [selectedNoteId, setSelectedNoteId] = React.useState<string | null>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewportHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, first + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2)
  const visibleRows = rows.slice(first, last)

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)
    if (
      hasNextPage &&
      !loading &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 320
    ) {
      onLoadNextPage()
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (rows.length === 0) return
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.noteId === selectedNoteId),
    )
    const nextIndex = (() => {
      if (event.key === "ArrowDown") return Math.min(rows.length - 1, currentIndex + 1)
      if (event.key === "ArrowUp") return Math.max(0, currentIndex - 1)
      if (event.key === "Home") return 0
      if (event.key === "End") return rows.length - 1
      return null
    })()
    if (nextIndex === null) return
    event.preventDefault()
    setSelectedNoteId(rows[nextIndex].noteId)
    onRowSelect?.(rows[nextIndex])
    viewportRef.current?.scrollTo({ top: nextIndex * ROW_HEIGHT, behavior: "auto" })
  }

  return (
    <div
      ref={viewportRef}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={3}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto outline-none"
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
    >
      <div className="min-w-[38rem]">
        <div
          role="row"
          className="sticky top-0 z-10 grid grid-cols-[minmax(16rem,2fr)_minmax(14rem,1.5fr)_minmax(8rem,1fr)] border-b border-border bg-card text-[11px] font-semibold"
        >
          <div
            role="columnheader"
            className="sticky left-0 z-20 border-r border-border bg-card px-3 py-2"
          >
            {t("databaseTable.title")}
          </div>
          <div role="columnheader" className="border-r border-border px-3 py-2">
            {t("databaseTable.path")}
          </div>
          <div role="columnheader" className="px-3 py-2">
            {t("databaseTable.id")}
          </div>
        </div>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          <div style={{ position: "absolute", top: first * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleRows.map((row, index) => (
              <div
                key={row.noteId}
                role="row"
                aria-rowindex={first + index + 2}
                aria-selected={selectedNoteId === row.noteId}
                className={`grid h-9 grid-cols-[minmax(16rem,2fr)_minmax(14rem,1.5fr)_minmax(8rem,1fr)] border-b border-border/60 text-xs hover:bg-accent/30 ${selectedNoteId === row.noteId ? "bg-accent/50" : ""}`}
                onClick={() => {
                  setSelectedNoteId(row.noteId)
                  onRowSelect?.(row)
                }}
              >
                <div
                  role="gridcell"
                  className={`sticky left-0 truncate border-r border-border/60 px-3 py-2 font-medium ${selectedNoteId === row.noteId ? "bg-accent/50" : "bg-background"}`}
                  style={{ paddingLeft: 12 + row.depth * 12 }}
                >
                  {row.title}
                </div>
                <div
                  role="gridcell"
                  className="truncate border-r border-border/60 px-3 py-2 text-muted-foreground"
                >
                  {row.relativePath}
                </div>
                <div
                  role="gridcell"
                  className="truncate px-3 py-2 font-mono text-[10px] text-muted-foreground"
                >
                  {row.noteId}
                </div>
              </div>
            ))}
          </div>
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("databaseTable.loading")}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center justify-center gap-2 border-t border-border px-4 py-4 text-xs text-destructive"
          >
            <AlertTriangle className="size-4" />
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" />
              {t("databaseTable.retry")}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

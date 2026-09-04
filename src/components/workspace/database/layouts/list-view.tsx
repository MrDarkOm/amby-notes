import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell } from "../database-value-cell"

interface ListViewProps {
  rows: DatabaseRow[]
  loading?: boolean
  error?: string | null
  hasNextPage?: boolean
  onLoadNextPage?: () => void
  onRetry?: () => void
  onRowSelect?: (row: DatabaseRow) => void
}

export function ListView({
  rows,
  loading = false,
  error = null,
  hasNextPage = false,
  onLoadNextPage,
  onRetry,
  onRowSelect,
}: ListViewProps) {
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    if (
      hasNextPage &&
      !loading &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 320
    ) {
      onLoadNextPage?.()
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" onScroll={handleScroll}>
      <div className="mx-auto max-w-3xl space-y-2">
        {rows.map((row) => (
          <button
            key={row.noteId}
            type="button"
            className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-card/50 px-4 py-3 text-left transition-colors hover:bg-accent/40"
            onClick={() => onRowSelect?.(row)}
          >
            <span className="min-w-0 flex-1" style={{ paddingLeft: 12 + row.depth * 12 }}>
              <span className="block truncate text-sm font-medium">{row.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.categoryPath.length > 0 ? `${row.categoryPath.join(" / ")} · ` : ""}
                {row.relativePath}
              </span>
              <DatabaseValueCell row={row} />
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {row.noteId}
            </span>
          </button>
        ))}
        <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
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

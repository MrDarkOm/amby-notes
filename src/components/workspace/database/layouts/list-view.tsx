import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseValueCell, type CardCellEdit } from "../database-value-cell"
import { CardSurface } from "./card-surface"
import { PageIcon } from "../page-icon"
import { listColumns } from "./list-columns"

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
}: ListViewProps) {
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
    <div className="min-h-0 min-w-0 flex-1 overflow-auto py-1" onScroll={handleScroll}>
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
            role="listitem"
            className="col-span-full grid min-h-10 cursor-pointer grid-cols-subgrid items-center gap-x-3 rounded-lg px-2 py-1 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
            onOpen={() => onRowSelect?.(row)}
          >
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
        <div className="col-span-full">
          <LayoutStatus loading={loading} error={error} onRetry={onRetry} />
        </div>
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

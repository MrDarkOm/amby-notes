import * as React from "react"
import { BarChart3 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  aggregateDatabase,
  type DatabaseAggregateResult,
  type DatabaseFieldRef,
  type DatabaseFilterNode,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

interface ChartViewProps {
  databaseId: string
  expectedGeneration: number | null
  enabled: boolean
  category?: DatabaseFieldRef
  /** The view's filter and the toolbar search: the chart counts what the table shows. */
  filter?: DatabaseFilterNode
  search?: string
}

export function ChartView({
  databaseId,
  expectedGeneration,
  enabled,
  category,
  filter,
  search = "",
}: ChartViewProps) {
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const requestToken = React.useRef(0)
  const { t } = useTranslation()
  const [result, setResult] = React.useState<DatabaseAggregateResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!enabled || expectedGeneration === null) return
    const mine = ++requestToken.current
    setLoading(true)
    setError(null)
    try {
      const next = await aggregateDatabase({
        expectedGeneration,
        databaseId,
        source: { kind: "inline", spec: { filter, sorts: [] } },
        category,
        aggregation: "count",
        search: search.trim() || undefined,
        limit: 12,
      })
      // An older answer must not replace the result for the current filter.
      if (mine === requestToken.current) setResult(next)
    } catch (reason) {
      if (mine === requestToken.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (mine === requestToken.current) setLoading(false)
    }
    // `invalidationSeq` reloads the chart whenever the projection changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, databaseId, enabled, expectedGeneration, filter, search, invalidationSeq])

  React.useEffect(() => {
    void load()
  }, [load])

  const maxCount = Math.max(...(result?.groups.map((group) => group.count) ?? [0]), 1)

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-4xl rounded-xl border border-border/70 bg-card/40 p-5">
        <div className="mb-5 flex items-center gap-2">
          <BarChart3 className="size-5 text-primary" />
          <div>
            <h2 className="text-sm font-medium">{t("databaseChart.title")}</h2>
            <p className="text-xs text-muted-foreground">{t("databaseChart.description")}</p>
          </div>
        </div>
        {loading && (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("databaseChart.loading")}
          </p>
        )}
        {!loading && error && (
          <div
            className="flex items-center justify-center gap-2 py-10 text-xs text-destructive"
            role="alert"
          >
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              {t("databaseTable.retry")}
            </Button>
          </div>
        )}
        {!loading && !error && result && result.groups.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("databaseChart.empty")}
          </p>
        )}
        {!loading && !error && result && result.groups.length > 0 && (
          <div className="space-y-3">
            {result.groups.map((group) => (
              <div
                key={group.key}
                className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3 text-xs"
              >
                <span className="truncate" title={group.label}>
                  {group.label}
                </span>
                <div className="h-6 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-primary"
                    style={{ width: `${Math.max((group.count / maxCount) * 100, 2)}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-muted-foreground">
                  {group.count}
                </span>
              </div>
            ))}
            {result.totalCount > result.groups.reduce((sum, group) => sum + group.count, 0) && (
              <p className="pt-2 text-right text-xs text-muted-foreground">
                {t("databaseChart.total", { count: result.totalCount })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

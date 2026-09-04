import { useTranslation } from "react-i18next"
import type { DatabaseLinkedReference } from "./linked-reference"
import { useDatabaseQuery } from "./use-database-query"
import { useDatabaseStore } from "./database-store"

interface DatabaseLinkedViewProps {
  reference: DatabaseLinkedReference
}

export function DatabaseLinkedView({ reference }: DatabaseLinkedViewProps) {
  const { t } = useTranslation()
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const { host, retry } = useDatabaseQuery({
    databaseId: reference.databaseId,
    viewId: reference.viewId,
    hostKind: "block",
    vaultGeneration,
    enabled: Boolean(runtime?.enabled) && catalogStatus === "ready",
  })
  if (!runtime?.enabled || catalogStatus !== "ready") {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {t("databaseLinkedView.unavailable")}
      </p>
    )
  }
  if (host?.error) {
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-4 text-xs text-destructive">
        <span>{host.error}</span>
        <button type="button" className="underline" onClick={retry}>
          {t("databaseTable.retry")}
        </button>
      </div>
    )
  }
  if (host?.status === "loading" && host.rows.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">{t("databaseLinkedView.loading")}</p>
    )
  }
  return (
    <div className="overflow-hidden">
      {host?.rows.slice(0, 5).map((row) => (
        <div
          key={row.noteId}
          className="flex items-center gap-3 border-b border-border/60 px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
          <span className="truncate text-muted-foreground">{row.relativePath}</span>
        </div>
      ))}
      {host?.rows.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">{t("databaseLinkedView.empty")}</p>
      )}
    </div>
  )
}

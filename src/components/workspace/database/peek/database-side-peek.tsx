import * as React from "react"
import type { ReactNode } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type {
  DatabaseRow,
  DatabaseYamlConflict,
  DatabaseYamlResolution,
  DatabaseYamlSyncResult,
} from "@/lib/storage"

interface DatabaseSidePeekProps {
  row: DatabaseRow
  body?: ReactNode
  canPrevious?: boolean
  canNext?: boolean
  onPrevious?: () => void
  onNext?: () => void
  onOpenFullPage?: () => void
  yamlSync?: {
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
    onSync: () => void
    onResolve: (
      conflict: DatabaseYamlConflict,
      resolution: DatabaseYamlResolution,
      manualValueJson?: string,
    ) => void
  }
  onClose: () => void
}

export function DatabaseSidePeek({
  row,
  body,
  canPrevious = false,
  canNext = false,
  onPrevious,
  onNext,
  onOpenFullPage,
  yamlSync,
  onClose,
}: DatabaseSidePeekProps) {
  const { t } = useTranslation()
  const [manualValues, setManualValues] = React.useState<Record<string, string>>({})
  return (
    <aside className="flex h-full w-[min(42rem,45vw)] min-w-[20rem] flex-col border-l border-border bg-card shadow-xl">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{row.title}</h2>
          <p className="truncate text-[10px] text-muted-foreground">{row.relativePath}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canPrevious}
          onClick={onPrevious}
          title={t("databasePeek.previous")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canNext}
          onClick={onNext}
          title={t("databasePeek.next")}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenFullPage}
          title={t("databasePeek.openFullPage")}
        >
          <ExternalLink className="size-4" />
        </Button>
        {yamlSync && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={yamlSync.busy}
            onClick={yamlSync.onSync}
            title={t("databasePeek.syncYaml")}
            aria-label={t("databasePeek.syncYaml")}
          >
            <RefreshCw className={yamlSync.busy ? "size-4 animate-spin" : "size-4"} />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} title={t("common.close")}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {body ?? (
          <p className="text-sm text-muted-foreground">{t("databasePeek.bodyPlaceholder")}</p>
        )}
        {yamlSync?.error && (
          <p role="alert" className="mt-4 text-xs text-destructive">
            {yamlSync.error}
          </p>
        )}
        {yamlSync?.result && yamlSync.result.conflicts.length > 0 && (
          <section className="mt-4 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <h3 className="text-xs font-semibold">
              {t("databasePeek.yamlConflicts", { count: yamlSync.result.conflicts.length })}
            </h3>
            {yamlSync.result.conflicts.map((conflict) => (
              <div key={conflict.propertyId} className="space-y-2 text-[11px]">
                <p className="font-medium">{conflict.yamlKey}</p>
                <p className="break-all text-muted-foreground">
                  {t("databasePeek.yamlConflictValues", {
                    shard: conflict.shardJson,
                    yaml: conflict.yamlJson,
                  })}
                </p>
                {yamlSync && (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => yamlSync.onResolve(conflict, "shard")}
                    >
                      {t("databasePeek.keepDatabase")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => yamlSync.onResolve(conflict, "yaml")}
                    >
                      {t("databasePeek.keepYaml")}
                    </Button>
                  </div>
                )}
                {yamlSync && (
                  <div className="space-y-1">
                    <label
                      className="block text-muted-foreground"
                      htmlFor={`yaml-manual-${conflict.propertyId}`}
                    >
                      {t("databasePeek.manualValue")}
                    </label>
                    <input
                      id={`yaml-manual-${conflict.propertyId}`}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={manualValues[conflict.propertyId] ?? ""}
                      onChange={(event) =>
                        setManualValues((values) => ({
                          ...values,
                          [conflict.propertyId]: event.target.value,
                        }))
                      }
                      placeholder={t("databasePeek.manualValueHint")}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!manualValues[conflict.propertyId]?.trim()}
                      onClick={() =>
                        yamlSync.onResolve(
                          conflict,
                          "manual",
                          manualValues[conflict.propertyId]?.trim() ?? "",
                        )
                      }
                    >
                      {t("databasePeek.applyManual")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}

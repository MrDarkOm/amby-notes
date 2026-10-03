import * as React from "react"
import { PageIcon } from "../page-icon"
import type { ReactNode } from "react"
import { motion } from "motion/react"
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { cardSpring } from "../database-motion"
import type {
  DatabaseRow,
  DatabaseYamlConflict,
  DatabaseYamlResolution,
  DatabaseYamlSyncResult,
} from "@/lib/storage"

interface DatabaseSidePeekProps {
  row: DatabaseRow
  /** Side panel next to the view, or a large centered window. */
  variant?: "side" | "center"
  /** Editable properties shown above the note body. */
  propertiesSection?: ReactNode
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
  variant = "side",
  propertiesSection,
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
  React.useEffect(() => {
    if (variant !== "center") return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, variant])
  const panel = (
    <motion.aside
      role={variant === "center" ? "dialog" : undefined}
      // The big window rises and fades in; the side panel slides in from the edge.
      initial={variant === "center" ? { opacity: 0, y: 24, scale: 0.97 } : { opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={variant === "center" ? { opacity: 0, y: 12, scale: 0.98 } : { opacity: 0, x: 40 }}
      transition={motionTransition(cardSpring)}
      aria-modal={variant === "center" || undefined}
      aria-label={row.title}
      className={
        variant === "center"
          ? "flex h-[88vh] w-[min(64rem,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          : "flex h-full w-[min(56rem,60vw)] min-w-[20rem] flex-col border-l border-border bg-card shadow-xl"
      }
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <PageIcon noteId={row.noteId} />
            <span className="truncate">{row.title}</span>
          </h2>
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
            {yamlSync.busy ? (
              <MotionSpinner>
                <RefreshCw className="size-4" />
              </MotionSpinner>
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} title={t("common.close")}>
          <X className="size-4" />
        </Button>
      </header>
      {propertiesSection && (
        <section
          aria-label={t("databasePeek.properties")}
          className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border px-4 py-2"
        >
          {propertiesSection}
        </section>
      )}
      <div
        className={
          body
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto p-4"
        }
      >
        {body ? (
          <div className="flex min-h-0 flex-1">{body}</div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("databasePeek.bodyPlaceholder")}</p>
        )}
        {yamlSync?.error && (
          <p role="alert" className="m-4 text-xs text-destructive">
            {yamlSync.error}
          </p>
        )}
        {yamlSync?.result && yamlSync.result.conflicts.length > 0 && (
          <section className="m-4 max-h-64 space-y-2 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-3">
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
    </motion.aside>
  )
  if (variant !== "center") return panel
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionTransition(motionTransitions.default)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {panel}
    </motion.div>
  )
}

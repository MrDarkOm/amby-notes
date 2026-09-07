import { AlertTriangle, Database, ExternalLink, Loader2, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import { motionTransitions } from "@/lib/motion-config"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"

export function DatabasesPanel({ databaseRuntimeEnabled, onOpenDatabase }: PanelRenderProps) {
  const { t } = useTranslation()
  const status = useDatabaseStore((state) => state.catalogStatus)
  const databases = useDatabaseStore((state) => state.databases)
  const diagnostics = useDatabaseStore((state) => state.diagnostics)
  const error = useDatabaseStore((state) => state.error)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b px-4 py-4 text-sm font-semibold">
        <Database className="size-4 text-muted-foreground" />
        {t("panels.databases")}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          {status === "ready" ? databases.length : t(`databasePanel.status.${status}`)}
        </span>
      </header>
      {!databaseRuntimeEnabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <Database className="size-7 text-muted-foreground" />
          <p className="text-xs font-medium">{t("databasePanel.disabledTitle")}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("databasePanel.disabledDescription")}
          </p>
        </div>
      ) : status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <MotionSpinner>
            <Loader2 className="size-4" />
          </MotionSpinner>
        </div>
      ) : status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
          <AlertTriangle className="size-7 text-amber-500" />
          <p className="text-xs font-medium">{t("databasePanel.loadFailed")}</p>
          <p className="break-words text-[11px] text-muted-foreground">{error}</p>
        </div>
      ) : databases.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <RefreshCw className="size-7 text-muted-foreground" />
          <p className="text-xs font-medium">{t("databasePanel.empty")}</p>
          <p className="text-[11px] text-muted-foreground">{t("databasePanel.emptyHint")}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {diagnostics.length > 0 && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("databasePanel.diagnostics", { count: diagnostics.length })}</span>
            </div>
          )}
          <div className="space-y-1">
            {databases.map((database) => (
              <motion.div
                key={database.databaseId}
                className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-accent/40"
                initial="rest"
                whileHover="hover"
              >
                <Database className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{database.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {t("databasePanel.views", { count: database.views.length })}
                    {database.diagnostics.length > 0
                      ? ` · ${t("databasePanel.diagnostics", { count: database.diagnostics.length })}`
                      : ""}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  variants={{ rest: { opacity: 0 }, hover: { opacity: 1 } }}
                  whileFocus={{ opacity: 1 }}
                  transition={motionTransitions.fast}
                  title={t("databasePanel.open")}
                  aria-label={t("databasePanel.open")}
                  onClick={() => onOpenDatabase?.(database.databaseId, database.title)}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

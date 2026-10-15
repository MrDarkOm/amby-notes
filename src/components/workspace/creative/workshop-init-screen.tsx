import * as React from "react"
import { Feather, Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  initWorkshop,
  ProjectOperationError,
  type CreatedWorkshop,
  type WorkshopSummary,
} from "@/lib/storage"
import { projectErrorText } from "./project-error"
import { projectLabels } from "./project-labels"
import { useOperationId } from "./use-operation-id"

interface WorkshopInitScreenProps {
  /** The vault-relative folder the workshop will be made in (the setting, or the default). */
  path: string
  /** Workshop markers found elsewhere in the vault: named, never touched. */
  others: WorkshopSummary[]
  vaultGeneration: number | null
  /** Called after the workshop was made; the panel reads the catalog again. */
  onInitialized: (created: CreatedWorkshop) => Promise<void> | void
  onOpenSettings?: () => void
}

/**
 * The panel of a vault that has no workshop at the chosen folder: what a workshop is, where it
 * will be made, and the one button that makes it. A folder that holds anything else is refused by
 * Rust before the first write; this screen only says so and points at the setting.
 */
export function WorkshopInitScreen({
  path,
  others,
  vaultGeneration,
  onInitialized,
  onOpenSettings,
}: WorkshopInitScreenProps) {
  const { t } = useTranslation()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const operationId = useOperationId("init-workshop", { path })

  const initialize = async () => {
    if (pending || vaultGeneration === null) return
    setPending(true)
    setError(null)
    try {
      const created = await initWorkshop({
        expectedGeneration: vaultGeneration,
        operationId: operationId(),
        path,
        labels: projectLabels(t),
      })
      await onInitialized(created)
    } catch (caught) {
      const notEmpty =
        caught instanceof ProjectOperationError &&
        caught.error?.kind === "failed" &&
        caught.error.code === "folderNotEmpty"
      setError(
        notEmpty ? t("creative.errors.folderNotEmpty", { path }) : projectErrorText(t, caught),
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      data-testid="workshop-init"
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <Feather className="size-7 text-muted-foreground" aria-hidden="true" />
      <p className="text-xs font-medium">{t("creative.init.title")}</p>
      <p className="break-words text-[11px] text-muted-foreground">{t("creative.init.hint")}</p>
      <p className="max-w-full break-all rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]">
        {t("creative.init.folder", { path })}
      </p>
      <Button
        size="sm"
        className="h-auto min-h-8 max-w-full whitespace-normal"
        disabled={pending || vaultGeneration === null}
        onClick={() => void initialize()}
      >
        {pending ? t("creative.init.working") : t("creative.init.button")}
      </Button>
      {error && (
        <p role="alert" className="break-words text-[11px] text-destructive">
          {error}
        </p>
      )}
      {others.length > 0 && (
        <p className="break-words text-[11px] text-muted-foreground">
          {t("creative.init.others", {
            paths: others.map((workshop) => workshop.path || "/").join(", "),
          })}
        </p>
      )}
      <p className="break-words text-[11px] text-muted-foreground">
        {t("creative.init.settingsHint")}
      </p>
      {onOpenSettings && (
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onOpenSettings}>
          <Settings className="size-3.5" />
          {t("creative.init.settings")}
        </Button>
      )}
    </div>
  )
}

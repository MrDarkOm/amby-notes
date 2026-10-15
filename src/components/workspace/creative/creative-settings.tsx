import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { openVault, resolveWorkshopFolder } from "@/lib/storage"
import { Row } from "../settings/settings-common"
import { projectErrorText } from "./project-error"
import { useCreativeSettingsStore } from "./creative-settings-store"

/** The creative module's page in Settings → Modules. */
export function CreativeSettings() {
  const { t } = useTranslation()
  const showInTree = useCreativeSettingsStore((state) => state.showInTree)
  const setShowInTree = useCreativeSettingsStore((state) => state.setShowInTree)
  const workshopPath = useCreativeSettingsStore((state) => state.workshopPath)
  const setWorkshopPath = useCreativeSettingsStore((state) => state.setWorkshopPath)
  const load = useCreativeSettingsStore((state) => state.load)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  // The settings window has a store of its own: read what the vault has saved.
  React.useEffect(() => {
    void load()
  }, [load])

  const shown = workshopPath ?? t("creative.workshop.defaultFolder")

  /** The folder dialog is the app's own; Rust turns the pick into a path inside the vault. */
  const choose = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const picked = await openVault()
      if (!picked) return
      const relative = await resolveWorkshopFolder(picked)
      await setWorkshopPath(relative)
    } catch (caught) {
      setError(
        t("creative.settings.workshopFolderFailed", { message: projectErrorText(t, caught) }),
      )
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setError(null)
    try {
      await setWorkshopPath(null)
    } catch (caught) {
      setError(
        t("creative.settings.workshopFolderFailed", { message: projectErrorText(t, caught) }),
      )
    }
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      <Row
        label={t("creative.settings.workshopFolder")}
        hint={t("creative.settings.workshopFolderHint")}
      >
        <div className="flex max-w-80 flex-col items-end gap-1.5">
          <span
            className="max-w-full truncate rounded-md border border-border bg-card px-2 py-1 font-mono text-[12px]"
            title={shown}
            data-testid="workshop-folder"
          >
            {shown}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void choose()}>
              {t("creative.settings.workshopFolderChoose")}
            </Button>
            {workshopPath !== null && (
              <Button variant="ghost" size="sm" onClick={() => void reset()}>
                {t("creative.settings.workshopFolderReset")}
              </Button>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="max-w-full break-words text-right text-[11px] text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      </Row>
      <Row label={t("creative.settings.showInTree")} hint={t("creative.settings.showInTreeHint")}>
        <Switch
          checked={showInTree}
          onCheckedChange={(value) => void setShowInTree(value)}
          aria-label={t("creative.settings.showInTree")}
        />
      </Row>
    </div>
  )
}

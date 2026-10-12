import * as React from "react"
import { useTranslation } from "react-i18next"
import { Switch } from "@/components/ui/switch"
import { Row } from "../settings/settings-common"
import { useCreativeSettingsStore } from "./creative-settings-store"

/** The creative module's page in Settings → Modules. */
export function CreativeSettings() {
  const { t } = useTranslation()
  const showInTree = useCreativeSettingsStore((state) => state.showInTree)
  const setShowInTree = useCreativeSettingsStore((state) => state.setShowInTree)
  const load = useCreativeSettingsStore((state) => state.load)
  // The settings window has a store of its own: read what the vault has saved.
  React.useEffect(() => {
    void load()
  }, [load])
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
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

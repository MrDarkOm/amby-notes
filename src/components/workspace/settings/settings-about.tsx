import * as React from "react"
import { useTranslation } from "react-i18next"
import { Info, Scale } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getCurrentAppVersion } from "@/lib/app-updater"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { Row, SettingsGroup } from "./settings-common"
import { EmojiLicenses } from "./emoji-licenses"

const SOURCE_CODE_URL = "https://github.com/MrDarkOm/amby-notes"

/** Settings → About: the version, Amby's own license with its source, then `children` (updates and
 * diagnostics), then the bundled open licenses. */
export function AboutSettings({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation()
  const [version, setVersion] = React.useState("")

  React.useEffect(() => {
    let alive = true
    void getCurrentAppVersion().then((next) => alive && setVersion(next))
    return () => {
      alive = false
    }
  }, [])

  return (
    <>
      <SettingsGroup title={t("settings.about.app")} icon={Info}>
        <Row label={t("settings.updates.currentVersion")}>
          <span
            data-testid="about-version"
            className="text-[13px] tabular-nums text-muted-foreground"
          >
            {version}
          </span>
        </Row>
        <Row label={t("settings.updates.license")} hint={t("settings.updates.licenseHint")}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void openWebAddressInBrowser(SOURCE_CODE_URL)}
          >
            {t("settings.updates.sourceAction")}
          </Button>
        </Row>
      </SettingsGroup>
      {children}
      <SettingsGroup title={t("settings.updates.thirdPartyLicenses")} icon={Scale}>
        <EmojiLicenses />
      </SettingsGroup>
    </>
  )
}

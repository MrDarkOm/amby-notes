import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { MotionSpinner } from "@/lib/motion"
import {
  checkForAppUpdate,
  getCurrentAppVersion,
  isAppUpdaterAvailable,
  type AvailableAppUpdate,
  type UpdateInstallProgress,
} from "@/lib/app-updater"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { useSettingsStore } from "../use-settings-store"
import { Row } from "./settings-common"

const SOURCE_CODE_URL = "https://github.com/MrDarkOm/amby-notes"

type UpdateUiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; percent: number | null }
  | { phase: "installing" | "restarting" }
  | { phase: "error" }

export function UpdateSettings() {
  const { t } = useTranslation()
  const prefs = useSettingsStore((state) => state.prefs)
  const setPrefs = useSettingsStore((state) => state.setPrefs)
  const supported = isAppUpdaterAvailable()
  const [version, setVersion] = React.useState("…")
  const [update, setUpdate] = React.useState<AvailableAppUpdate | null>(null)
  const [state, setState] = React.useState<UpdateUiState>({ phase: "idle" })

  React.useEffect(() => {
    void getCurrentAppVersion().then(setVersion)
  }, [])

  React.useEffect(() => {
    return () => {
      void update?.close().catch(() => {})
    }
  }, [update])

  const checkNow = async () => {
    setState({ phase: "checking" })
    try {
      const next = await checkForAppUpdate()
      setUpdate(next)
      setState(next ? { phase: "available", version: next.version } : { phase: "current" })
    } catch {
      setUpdate(null)
      setState({ phase: "error" })
    }
  }

  const install = async () => {
    if (!update) return
    const onProgress = (progress: UpdateInstallProgress) => setState(progress)
    try {
      await update.install(onProgress)
    } catch {
      setState({ phase: "error" })
    }
  }

  const status = !supported
    ? t("settings.updates.installedOnly")
    : state.phase === "checking"
      ? t("settings.updates.checking")
      : state.phase === "current"
        ? t("settings.updates.current")
        : state.phase === "available"
          ? t("settings.updates.available", { version: state.version })
          : state.phase === "downloading"
            ? state.percent === null
              ? t("settings.updates.downloading")
              : t("settings.updates.downloadingProgress", { progress: state.percent })
            : state.phase === "installing"
              ? t("settings.updates.installing")
              : state.phase === "restarting"
                ? t("settings.updates.restarting")
                : state.phase === "error"
                  ? t("settings.updates.error")
                  : t("settings.updates.checkHint")
  const busy = ["checking", "downloading", "installing", "restarting"].includes(state.phase)

  return (
    <>
      <Row label={t("settings.updates.autoUpdate")} hint={t("settings.updates.autoUpdateHint")}>
        <Switch
          checked={prefs.updates.autoUpdate}
          onCheckedChange={(autoUpdate) => setPrefs({ updates: { autoUpdate } })}
        />
      </Row>
      <Row label={t("settings.updates.currentVersion")}>
        <span className="text-[13px] tabular-nums text-muted-foreground">{version}</span>
      </Row>
      <Row label={t("settings.updates.check")} hint={status}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!supported || busy}
          onClick={() => void (update ? install() : checkNow())}
        >
          {busy && (
            <MotionSpinner>
              <Loader2 className="size-3.5" />
            </MotionSpinner>
          )}
          {update
            ? t("settings.updates.install", { version: update.version })
            : t("settings.updates.checkAction")}
        </Button>
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
    </>
  )
}

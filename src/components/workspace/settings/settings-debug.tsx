"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Bug, FolderOpen, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "../use-settings-store"
import { type LogLevelPref } from "../app-config"
import { Row, selectTrigger } from "./settings-common"
import { LogViewerDialog } from "./log-viewer-dialog"
import { isTauri, openDebugLogFolder, toggleDebugDevtools } from "@/lib/storage"
import { useDebugStore } from "./use-debug-store"

export function DebugSettings() {
  const { t } = useTranslation()
  const prefs = useSettingsStore((s) => s.prefs)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const status = useDebugStore((s) => s.status)
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void useDebugStore.getState().hydrate()
  }, [])

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch {
      setActionError(t("settings.debug.actionFailed"))
    }
  }

  return (
    <>
      <Row label={t("settings.debug.enabled")} hint={t("settings.debug.enabledHint")}>
        <Switch
          checked={prefs.debug.enabled}
          onCheckedChange={(enabled) =>
            void setPrefs({ debug: { ...prefs.debug, enabled } }).catch(() =>
              setActionError(t("settings.debug.configFailed")),
            )
          }
        />
      </Row>

      <Row label={t("settings.debug.viewLogs")} hint={t("settings.debug.openViewerHint")}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setViewerOpen(true)}
          className="gap-1.5"
        >
          <Bug className="size-3.5" />
          {t("settings.debug.openViewer")}
        </Button>
      </Row>

      <Row label={t("settings.debug.logLevel")} hint={t("settings.debug.logLevelHint")}>
        <Select
          value={prefs.debug.logLevel}
          onValueChange={(value) =>
            void setPrefs({ debug: { ...prefs.debug, logLevel: value as LogLevelPref } }).catch(
              () => setActionError(t("settings.debug.configFailed")),
            )
          }
        >
          <SelectTrigger className={selectTrigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">{t("settings.debug.logLevelDebug")}</SelectItem>
            <SelectItem value="info">{t("settings.debug.logLevelInfo")}</SelectItem>
            <SelectItem value="warn">{t("settings.debug.logLevelWarn")}</SelectItem>
            <SelectItem value="error">{t("settings.debug.logLevelError")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <Row
        label={t("settings.debug.logToFile")}
        hint={t(isTauri() ? "settings.debug.logToFileHint" : "settings.debug.logToFileBrowserHint")}
      >
        <div className="flex items-center gap-2">
          {isTauri() && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              title={t("settings.debug.openLogsFolder")}
              onClick={() => void runAction(openDebugLogFolder)}
            >
              <FolderOpen className="size-4" />
            </Button>
          )}
          <Switch
            checked={prefs.debug.logToFile}
            disabled={!isTauri()}
            onCheckedChange={(logToFile) =>
              void setPrefs({ debug: { ...prefs.debug, logToFile } }).catch(() =>
                setActionError(t("settings.debug.configFailed")),
              )
            }
          />
        </div>
      </Row>

      {isTauri() && (
        <Row label={t("settings.debug.devtoolsTitle")} hint={t("settings.debug.openDevToolsHint")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runAction(toggleDebugDevtools)}
            className="gap-1.5"
          >
            <Terminal className="size-3.5" />
            {t("settings.debug.openDevTools")}
          </Button>
        </Row>
      )}

      {(actionError || status.transportError || status.backend?.fileError) && (
        <div className="amby-debug-settings-error" role="status">
          {actionError ?? status.transportError ?? status.backend?.fileError}
        </div>
      )}
      <LogViewerDialog open={viewerOpen} onOpenChange={setViewerOpen} />
    </>
  )
}

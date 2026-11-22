"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { errorType, logger } from "@/lib/logger"
import { isTauri, revealAppDataFolder } from "@/lib/storage"
import { cn } from "@/lib/utils"
import {
  DEFAULT_PREFS,
  DELETE_MODES,
  type DeleteModePref,
  loadWorkspaceConfig,
  saveWorkspaceConfigPatch,
  saveWorkspaces,
  WORKSPACES_SCHEMA_VERSION,
} from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import { useVaultStore } from "../use-vault-store"
import { NoticeLine } from "../notices/notice-line"
import { Row, selectTrigger } from "./settings-common"

/** Matches the small outline buttons of the other settings rows. */
const actionButton = "h-7 text-[12px] font-normal [&_svg:not([class*='size-'])]:size-3.5"

export function DataTab({ vault }: { vault: string | null }) {
  const { t } = useTranslation()
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const setVaults = useVaultStore((s) => s.setVaults)
  const [dir, setDir] = React.useState<string>("")
  /** The answer to "Open folder" when the folder could not be shown stands under the button (docs/notices.md, section 8). */
  const [openFailed, setOpenFailed] = React.useState(false)

  async function openDataFolder() {
    setOpenFailed(false)
    try {
      await revealAppDataFolder()
    } catch (error) {
      logger.warn("vault.reveal_failed", { errorType: errorType(error) })
      setOpenFailed(true)
    }
  }

  React.useEffect(() => {
    if (!isTauri()) return
    import("@tauri-apps/api/path")
      .then(({ localDataDir }) => localDataDir())
      .then((base) => setDir(`${base.replace(/[/\\]$/, "")}/Amby/notes`))
      // The folder shown as a hint is unknown: the hint stays empty.
      .catch(() => {})
  }, [])

  const path = dir || (isTauri() ? "…" : "localStorage (web)")

  return (
    <>
      <Row
        label={t("settings.data.location")}
        hint={
          <>
            <span title={path} className="block truncate font-mono">
              {path}
            </span>
            {openFailed && (
              <NoticeLine text={t("settings.data.openFolderFailed")} className="mt-1" />
            )}
          </>
        }
      >
        {isTauri() && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={actionButton}
            onClick={() => void openDataFolder()}
            disabled={!dir}
          >
            <FolderOpen />
            {t("settings.data.openFolder")}
          </Button>
        )}
      </Row>
      <Row label={t("settings.data.reset")} hint={t("settings.data.resetHint")}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={actionButton}
          onClick={async () => {
            if (await confirm(confirmations.resetSettings())) setPrefs({ ...DEFAULT_PREFS })
          }}
        >
          <RotateCcw />
          {t("settings.data.resetAction")}
        </Button>
      </Row>
      <Row label={t("settings.data.recent")} hint={t("settings.data.recentHint")}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(actionButton, "text-destructive hover:text-destructive")}
          onClick={() => {
            setVaults([])
            void saveWorkspaces({
              schemaVersion: WORKSPACES_SCHEMA_VERSION,
              recent: [],
              lastOpened: vault,
            })
          }}
        >
          <Trash2 />
          {t("settings.data.clearRecent")}
        </Button>
      </Row>
    </>
  )
}

export function DeleteConfirmationSetting({ vault }: { vault: string | null }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    if (!vault) return
    loadWorkspaceConfig()
      .then((config) => {
        if (!cancelled) setEnabled(config.confirmations.confirmFileDelete)
      })
      // The setting could not be read: the switch keeps its default and the setting file is not
      // touched.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [vault])

  return (
    <Row
      label={t("settings.general.confirmFileDelete")}
      hint={
        vault
          ? t("settings.general.confirmFileDeleteHint")
          : t("settings.general.vaultSettingUnavailable")
      }
    >
      <Switch
        checked={enabled}
        disabled={!vault}
        onCheckedChange={(next) => {
          setEnabled(next)
          void saveWorkspaceConfigPatch({
            confirmations: { confirmFileDelete: next },
          }).catch(() => setEnabled(!next))
        }}
      />
    </Row>
  )
}

export function DeleteModeSetting() {
  const { t } = useTranslation()
  const files = useSettingsStore((s) => s.prefs.files)
  const mode = files.deleteMode
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  return (
    <Row
      label={t("settings.general.deleteMode")}
      hint={t(`settings.general.deleteModeHint.${mode}`)}
    >
      <Select
        value={mode}
        onValueChange={(value) =>
          // The failed save is already reported by the settings window (emitSettingsSaveError);
          // nothing more to do here.
          void setPrefs({ files: { ...files, deleteMode: value as DeleteModePref } }).catch(
            () => {},
          )
        }
      >
        <SelectTrigger className={selectTrigger}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DELETE_MODES.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`settings.general.deleteModeOption.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

export function FolderClickSetting() {
  const { t } = useTranslation()
  const files = useSettingsStore((s) => s.prefs.files)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  return (
    <Row
      label={t("settings.general.folderClickToggles")}
      hint={t("settings.general.folderClickTogglesHint")}
    >
      <Switch
        checked={!files.folderClickToggles}
        onCheckedChange={(next) =>
          // A failed save is already reported by the settings window.
          void setPrefs({ files: { ...files, folderClickToggles: !next } }).catch(() => {})
        }
      />
    </Row>
  )
}

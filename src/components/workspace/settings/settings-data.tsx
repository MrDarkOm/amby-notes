"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, RotateCcw, Trash2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { confirmAction, isTauri, openInExplorer } from "@/lib/storage"
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
import { Row, selectTrigger } from "./settings-common"

export function DataTab({ vault }: { vault: string | null }) {
  const { t } = useTranslation()
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const setVaults = useVaultStore((s) => s.setVaults)
  const [dir, setDir] = React.useState<string>("")

  React.useEffect(() => {
    if (!isTauri()) return
    import("@tauri-apps/api/path")
      .then(({ localDataDir }) => localDataDir())
      .then((base) => setDir(`${base.replace(/[/\\]$/, "")}/Amby/notes`))
      .catch(() => {})
  }, [])

  const btn =
    "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] text-foreground hover:bg-card"

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 text-[13px] text-foreground">{t("settings.data.location")}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1.5 text-[12px] text-muted-foreground">
            {dir || (isTauri() ? "…" : "localStorage (web)")}
          </code>
          {isTauri() && (
            <button
              type="button"
              className={btn}
              onClick={() => void openInExplorer(dir)}
              disabled={!dir}
            >
              <FolderOpen className="size-4" />
              {t("settings.data.openFolder")}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className={btn}
          onClick={async () => {
            if (await confirmAction(t("settings.data.resetConfirm"))) setPrefs({ ...DEFAULT_PREFS })
          }}
        >
          <RotateCcw className="size-4" />
          {t("settings.data.reset")}
        </button>
        <button
          type="button"
          className={cn(btn, "text-red-300 hover:bg-red-950/30")}
          onClick={() => {
            setVaults([])
            void saveWorkspaces({
              schemaVersion: WORKSPACES_SCHEMA_VERSION,
              recent: [],
              lastOpened: vault,
            })
          }}
        >
          <Trash2 className="size-4" />
          {t("settings.data.clearRecent")}
        </button>
      </div>
    </div>
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
  const mode = useSettingsStore((s) => s.prefs.files.deleteMode)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  return (
    <Row
      label={t("settings.general.deleteMode")}
      hint={t(`settings.general.deleteModeHint.${mode}`)}
    >
      <Select
        value={mode}
        onValueChange={(value) =>
          void setPrefs({ files: { deleteMode: value as DeleteModePref } }).catch(() => {})
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

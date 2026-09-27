"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "../use-settings-store"
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  formatShortcut,
  shortcutFromEvent,
  type ShortcutActionId,
} from "../keyboard-shortcuts"

export function ShortcutsTab() {
  const { t } = useTranslation()
  const shortcuts = useSettingsStore((state) => state.prefs.shortcuts)
  const setPrefs = useSettingsStore((state) => state.setPrefs)
  const [recording, setRecording] = React.useState<ShortcutActionId | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  const updateShortcut = (id: ShortcutActionId, binding: string) => {
    const conflict = SHORTCUT_DEFINITIONS.find(
      (definition) => definition.id !== id && shortcuts[definition.id] === binding,
    )
    if (conflict) {
      setMessage(t("settings.shortcuts.conflict", { action: t(conflict.labelKey) }))
      return
    }
    setMessage(null)
    setRecording(null)
    void setPrefs({ shortcuts: { ...shortcuts, [id]: binding } })
  }

  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-[12px] text-muted-foreground">
          {t("settings.shortcuts.description")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setRecording(null)
            setMessage(null)
            void setPrefs({ shortcuts: { ...DEFAULT_SHORTCUTS } })
          }}
        >
          <RotateCcw className="size-3.5" />
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {SHORTCUT_DEFINITIONS.map((definition) => {
          const isRecording = recording === definition.id
          const isDefault = shortcuts[definition.id] === definition.defaultBinding
          return (
            <div
              key={definition.id}
              className="flex min-h-14 items-center justify-between gap-4 px-3 py-2.5"
            >
              <span className="min-w-0 text-[13px] text-foreground">{t(definition.labelKey)}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t("settings.shortcuts.change", {
                    action: t(definition.labelKey),
                  })}
                  aria-pressed={isRecording}
                  onClick={() => {
                    setMessage(null)
                    setRecording(definition.id)
                  }}
                  onBlur={() =>
                    setRecording((current) => (current === definition.id ? null : current))
                  }
                  onKeyDown={(event) => {
                    if (!isRecording) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.key === "Escape") {
                      setRecording(null)
                      setMessage(null)
                      return
                    }
                    const result = shortcutFromEvent(event)
                    if (result.status === "modifier-only") return
                    if (result.status === "needs-modifier") {
                      setMessage(t("settings.shortcuts.needsModifier"))
                      return
                    }
                    updateShortcut(definition.id, result.binding)
                  }}
                  className={cn(
                    "min-w-32 rounded-md border px-3 py-1.5 text-center font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    isRecording
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {isRecording
                    ? t("settings.shortcuts.recording")
                    : formatShortcut(shortcuts[definition.id])}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={isDefault}
                  title={t("settings.shortcuts.resetOne")}
                  aria-label={t("settings.shortcuts.resetOne")}
                  onClick={() => updateShortcut(definition.id, definition.defaultBinding)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <p
        role={message ? "alert" : undefined}
        className={cn(
          "min-h-5 text-[12px]",
          message ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message ?? t("settings.shortcuts.recordingHint")}
      </p>
    </div>
  )
}

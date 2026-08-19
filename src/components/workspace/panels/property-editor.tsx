"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { CustomProperty } from "@/lib/storage"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"

const CUSTOM_PROPERTY_TYPES = ["text", "number", "checkbox", "date", "select", "url"] as const

export interface PropertyEditorProps {
  property: CustomProperty | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (property: CustomProperty) => Promise<void>
  onDelete: (propertyId: string) => Promise<void>
}

export function PropertyEditor({
  property,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: PropertyEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<CustomProperty>({
    id: "",
    name: "",
    icon: "◆",
    propertyType: "text",
    value: "",
    settings: "",
  })
  const [emojiOpen, setEmojiOpen] = React.useState(false)
  const emojiRef = React.useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setDraft(
      property ?? {
        id: "",
        name: "",
        icon: "◆",
        propertyType: "text",
        value: "",
        settings: "",
      },
    )
    setEmojiOpen(false)
  }, [open, property])

  const options = draft.settings
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)

  async function save() {
    if (!draft.name.trim() || saving) return
    setSaving(true)
    try {
      await onSave(draft)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("infoPanel.propertyEditor")}</DialogTitle>
        </DialogHeader>
        <div className="relative flex items-center gap-2">
          <button
            ref={emojiRef}
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-base hover:bg-accent"
            onClick={() => setEmojiOpen((value) => !value)}
            title={t("infoPanel.propertyIcon")}
          >
            <IconValue value={draft.icon} fallback="◆" className="size-5" />
          </button>
          <Input
            value={draft.name}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
            placeholder={t("infoPanel.propertyName")}
            className="h-9 text-xs"
          />
          {emojiOpen && (
            <div className="absolute left-0 top-11 z-[70]">
              <EmojiPickerPanel
                triggerRef={emojiRef}
                onSelect={(emoji) => {
                  setDraft((value) => ({ ...value, icon: emoji.native }))
                  setEmojiOpen(false)
                }}
                onClose={() => setEmojiOpen(false)}
              />
            </div>
          )}
        </div>
        <label className="grid gap-1 text-[10px] text-muted-foreground">
          {t("infoPanel.propertyType")}
          <select
            value={draft.propertyType}
            onChange={(event) =>
              setDraft((value) => ({ ...value, propertyType: event.target.value, value: "" }))
            }
            className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {CUSTOM_PROPERTY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`infoPanel.propertyTypes.${type}`)}
              </option>
            ))}
          </select>
        </label>
        {draft.propertyType === "select" && (
          <label className="grid gap-1 text-[10px] text-muted-foreground">
            {t("infoPanel.propertyOptions")}
            <Input
              value={draft.settings}
              onChange={(event) =>
                setDraft((value) => ({ ...value, settings: event.target.value }))
              }
              placeholder={t("infoPanel.propertyOptionsHint")}
              className="h-9 text-xs"
            />
          </label>
        )}
        <label className="grid gap-1 text-[10px] text-muted-foreground">
          {t("infoPanel.propertyValue")}
          {draft.propertyType === "checkbox" ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={draft.value === "true"}
              className="flex h-9 items-center justify-between rounded-md border border-border px-3 text-xs text-foreground"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  value: value.value === "true" ? "false" : "true",
                }))
              }
            >
              {draft.value === "true" ? t("common.yes") : t("common.no")}
              <span>{draft.value === "true" ? "✓" : "○"}</span>
            </button>
          ) : draft.propertyType === "select" ? (
            <select
              value={draft.value}
              onChange={(event) => setDraft((value) => ({ ...value, value: event.target.value }))}
              className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              <option value="">—</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={
                draft.propertyType === "number"
                  ? "number"
                  : draft.propertyType === "date"
                    ? "date"
                    : draft.propertyType === "url"
                      ? "url"
                      : "text"
              }
              value={draft.value}
              onChange={(event) => setDraft((value) => ({ ...value, value: event.target.value }))}
              className="h-9 text-xs"
            />
          )}
        </label>
        <div className="flex items-center justify-between border-t border-border pt-3">
          {draft.id ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-destructive"
              onClick={async () => {
                await onDelete(draft.id)
                onOpenChange(false)
              }}
            >
              <Trash2 className="size-3.5" />
              {t("infoPanel.deleteProperty")}
            </button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!draft.name.trim() || saving}
            onClick={save}
          >
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

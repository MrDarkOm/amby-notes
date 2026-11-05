"use client"

import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { CustomProperty } from "@/lib/storage"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"
import { parseOptions, serializeOptions, validateOptions } from "../property-options"
import { propertyTypeIcon } from "../property-type-icons"
import { PropertyOptionsEditor } from "./property-options-editor"

const CUSTOM_PROPERTY_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "list",
  "url",
] as const

/** A select and a multi-select list their values in `settings` (docs/sync-plan.md, З62). */
const hasOptions = (type: string) => type === "select" || type === "list"

export interface PropertyEditorProps {
  property: CustomProperty | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (property: CustomProperty, options?: { addToDatabase?: boolean }) => Promise<void>
  onDelete: (propertyId: string) => Promise<void>
  databaseContext?: { databaseId: string; name?: string } | null
}

/** The items of a multi-select value kept in the form as a JSON list (docs/sync-plan.md, З62). */
function chosenItems(value: string): string[] {
  if (!value.startsWith("[")) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

export function PropertyEditor({
  property,
  open,
  onOpenChange,
  onSave,
  onDelete,
  databaseContext,
}: PropertyEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<CustomProperty>({
    id: "",
    name: "",
    icon: "",
    propertyType: "text",
    value: "",
    settings: "",
  })
  const [emojiOpen, setEmojiOpen] = React.useState(false)
  const emojiRef = React.useRef<HTMLButtonElement>(null)
  const saveAttempt = React.useRef(0)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const [addToDatabase, setAddToDatabase] = React.useState(true)

  React.useEffect(() => {
    saveAttempt.current++
    setSaving(false)
    if (!open) return
    setDraft(
      property ?? {
        id: "",
        name: "",
        icon: "",
        propertyType: "text",
        value: "",
        settings: "",
      },
    )
    setEmojiOpen(false)
    setError("")
    setOptionsInvalid(false)
    setAddToDatabase(true)
  }, [open, property])

  const [optionsInvalid, setOptionsInvalid] = React.useState(false)
  const options = parseOptions(draft.settings).options
  const PropertyTypeIcon = propertyTypeIcon(draft.propertyType)

  async function save() {
    if (!draft.name.trim() || saving) return
    if (hasOptions(draft.propertyType) && !validateOptions(options)) {
      setOptionsInvalid(true)
      return
    }
    // A new select starts with its default option, a new multi-select with a list of it (З62).
    const parsed = parseOptions(draft.settings)
    const toSave =
      hasOptions(draft.propertyType) && !draft.id && !draft.value && parsed.default
        ? {
            ...draft,
            value:
              draft.propertyType === "list" ? JSON.stringify([parsed.default]) : parsed.default,
            settings: serializeOptions(parsed.options, parsed.default),
          }
        : draft
    const attempt = saveAttempt.current
    setSaving(true)
    setError("")
    try {
      await onSave(toSave, {
        addToDatabase: Boolean(databaseContext && !draft.id && addToDatabase),
      })
      if (attempt === saveAttempt.current) onOpenChange(false)
    } catch {
      if (attempt === saveAttempt.current) setError(t("infoPanel.saveFailed"))
    } finally {
      if (attempt === saveAttempt.current) setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3 border-border bg-popover p-4 text-foreground">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("infoPanel.propertyEditor")}</DialogTitle>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <button
                ref={emojiRef}
                type="button"
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-base hover:bg-accent cursor-pointer"
                title={t("infoPanel.propertyIcon")}
              >
                <IconValue
                  value={draft.icon && draft.icon !== "◆" ? draft.icon : undefined}
                  fallback={<PropertyTypeIcon className="size-5" />}
                  className="size-5"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={4}
              collisionPadding={16}
              className="z-50 w-auto p-2 border-border bg-popover text-popover-foreground shadow-lg rounded-xl"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <EmojiPickerPanel
                triggerRef={emojiRef}
                onSelect={(emoji) => {
                  setDraft((value) => ({ ...value, icon: emoji.native }))
                  setEmojiOpen(false)
                }}
                onClear={() => {
                  setDraft((value) => ({ ...value, icon: "" }))
                  setEmojiOpen(false)
                }}
                clearLabel={t("tree.resetIcon")}
                onClose={() => setEmojiOpen(false)}
              />
            </PopoverContent>
          </Popover>
          <Input
            value={draft.name}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
            placeholder={t("infoPanel.propertyName")}
            className="h-9 text-xs"
          />
        </div>
        <label className="grid gap-1 text-[10px] text-muted-foreground">
          {t("infoPanel.propertyType")}
          <AmbySelect
            value={draft.propertyType}
            aria-label={t("infoPanel.propertyType")}
            options={CUSTOM_PROPERTY_TYPES.map((type) => ({
              value: type,
              label: t(`infoPanel.propertyTypes.${type}`),
            }))}
            onValueChange={(next) =>
              setDraft((value) => ({ ...value, propertyType: next, value: "" }))
            }
          />
        </label>
        {hasOptions(draft.propertyType) && (
          <PropertyOptionsEditor
            settings={draft.settings}
            invalid={optionsInvalid}
            onChange={(settings) => {
              setOptionsInvalid(false)
              setDraft((value) => ({ ...value, settings }))
            }}
          />
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
          ) : draft.propertyType === "list" ? (
            <div
              role="group"
              aria-label={t("infoPanel.propertyValue")}
              className="flex flex-wrap gap-1"
            >
              {options.map((option) => {
                const chosen = chosenItems(draft.value)
                const on = chosen.includes(option)
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={on}
                    aria-label={option}
                    onClick={() =>
                      setDraft((value) => {
                        const items = chosenItems(value.value)
                        const next = items.includes(option)
                          ? items.filter((item) => item !== option)
                          : [...items, option]
                        return { ...value, value: next.length ? JSON.stringify(next) : "" }
                      })
                    }
                    className={
                      on
                        ? "inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
                        : "inline-flex items-center rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent/40"
                    }
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          ) : draft.propertyType === "select" ? (
            <AmbySelect
              value={draft.value}
              aria-label={t("infoPanel.propertyValue", { defaultValue: draft.name })}
              options={options.map((option) => ({ value: option, label: option }))}
              onValueChange={(next) => setDraft((value) => ({ ...value, value: next }))}
            />
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
              className={
                draft.propertyType === "number" ? "amby-property-number h-9 text-xs" : "h-9 text-xs"
              }
            />
          )}
        </label>
        {databaseContext && !draft.id && (
          <div className="rounded-lg border border-border bg-accent/30 p-2.5 space-y-2">
            <div className="text-xs font-medium text-foreground">
              {t("infoPanel.addToDatabaseQuestion")}
            </div>
            <div className="flex flex-col gap-2 text-xs">
              <label className="flex items-start gap-2 cursor-pointer text-foreground">
                <input
                  type="radio"
                  name="addToDatabase"
                  checked={addToDatabase}
                  onChange={() => setAddToDatabase(true)}
                  className="mt-0.5 size-3.5 text-primary"
                />
                <span className="leading-tight">
                  <span className="font-medium">{t("infoPanel.forEntireDatabase")}</span>
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    {t("infoPanel.forEntireDatabaseDesc", {
                      database: databaseContext.name || databaseContext.databaseId,
                    })}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-foreground">
                <input
                  type="radio"
                  name="addToDatabase"
                  checked={!addToDatabase}
                  onChange={() => setAddToDatabase(false)}
                  className="mt-0.5 size-3.5 text-primary"
                />
                <span className="leading-tight">
                  <span className="font-medium">{t("infoPanel.onlyForThisNote")}</span>
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    {t("infoPanel.onlyForThisNoteDesc")}
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border pt-3">
          {draft.id ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-destructive"
              disabled={saving}
              onClick={async () => {
                const attempt = saveAttempt.current
                setSaving(true)
                setError("")
                try {
                  await onDelete(draft.id)
                  if (attempt === saveAttempt.current) onOpenChange(false)
                } catch {
                  if (attempt === saveAttempt.current) setError(t("infoPanel.saveFailed"))
                } finally {
                  if (attempt === saveAttempt.current) setSaving(false)
                }
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

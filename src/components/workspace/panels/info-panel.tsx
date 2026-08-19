"use client"

import * as React from "react"
import { Braces, Check, ChevronDown, Copy, Folder, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { CustomProperty } from "@/lib/storage"
import { IconValue } from "../icon-value"
import { PropertyEditor } from "./property-editor"
import type { PanelRenderProps } from "../panel-registry"

function PropertyRow({
  property,
  onEdit,
  onValueSave,
}: {
  property: CustomProperty
  onEdit: () => void
  onValueSave: (property: CustomProperty) => Promise<void>
}) {
  const { t } = useTranslation()
  const [value, setValue] = React.useState(property.value)
  React.useEffect(() => setValue(property.value), [property.value])
  const options = property.settings
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)

  async function saveValue(next = value) {
    if (next === property.value) return
    await onValueSave({ ...property, value: next })
  }

  if (property.propertyType === "checkbox") {
    const checked = value === "true"
    return (
      <div className="flex items-center overflow-hidden rounded-lg border border-border bg-background/30 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onEdit}
        >
          <span className="w-5 shrink-0 text-center text-sm" aria-hidden="true">
            <IconValue value={property.icon} fallback="☑️" className="size-4" />
          </span>
          <span className="truncate text-[11px] font-medium text-foreground">{property.name}</span>
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={property.name}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background hover:border-primary/60",
          )}
          onClick={() => {
            const next = checked ? "false" : "true"
            setValue(next)
            void saveValue(next)
          }}
        >
          {checked && <Check className="size-3.5" />}
        </button>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background/30">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/60"
        onClick={onEdit}
      >
        <span className="w-5 shrink-0 text-center text-sm" aria-hidden="true">
          <IconValue value={property.icon} fallback="◆" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {property.name}
        </span>
        <span className="text-[9px] text-muted-foreground">
          {t(`infoPanel.propertyTypes.${property.propertyType}`)}
        </span>
      </button>
      <div className="border-t border-border px-3 py-2">
        {property.propertyType === "select" ? (
          <select
            value={value}
            className="h-7 w-full rounded-md border-0 bg-transparent px-1 text-[11px] text-foreground outline-none"
            onChange={(event) => {
              setValue(event.target.value)
              void saveValue(event.target.value)
            }}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={
              property.propertyType === "number"
                ? "number"
                : property.propertyType === "date"
                  ? "date"
                  : property.propertyType === "url"
                    ? "url"
                    : "text"
            }
            value={value}
            className="h-7 w-full bg-transparent px-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="—"
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void saveValue()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur()
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

export function InfoPanel({
  properties,
  onSelectLink,
  onUpsertCustomProperty,
  onDeleteCustomProperty,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [propertyEditorOpen, setPropertyEditorOpen] = React.useState(false)
  const [editingProperty, setEditingProperty] = React.useState<CustomProperty | null>(null)
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("infoPanel.noDocument")}
      </div>
    )
  }
  const nestedNotes = properties.nestedNotes ?? []
  const customProperties =
    properties.kind === "folder" ? [] : (properties.frontmatter.customProperties ?? [])

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  if (properties.kind === "folder") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-3 py-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium text-foreground">
                {t("infoPanel.folderProperties")}
              </h2>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {t("infoPanel.folderDescription")}
              </p>
            </div>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {properties.noteCount}
            </span>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-5 px-3 py-3">
            {nestedNotes.length > 0 && (
              <section>
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("infoPanel.nestedNotes")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {nestedNotes.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/40 px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                      onClick={() => onSelectLink?.(note.id)}
                    >
                      <IconValue
                        value={
                          note.icon && !["file", "supernote"].includes(note.icon)
                            ? note.icon
                            : undefined
                        }
                        fallback="📄"
                        className="size-4"
                      />
                      <span className="truncate">{note.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="overflow-hidden rounded-lg border border-border bg-background/30">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <Folder className="size-4 text-muted-foreground" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("infoPanel.aboutFolder")}
                </span>
              </div>
              <div className="divide-y divide-border text-[10px]">
                {[
                  [t("infoPanel.type"), properties.type],
                  [t("infoPanel.notesCount"), String(properties.noteCount)],
                  [t("infoPanel.foldersCount"), String(properties.folderCount)],
                  [t("infoPanel.path"), properties.path || "—"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate text-right text-foreground" title={value}>
                      {value}
                    </span>
                  </div>
                ))}
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-muted-foreground">{t("infoPanel.id")}</span>
                  <code className="min-w-0 flex-1 break-all text-right font-mono text-[10px] text-foreground">
                    {properties.id}
                  </code>
                </div>
              </div>
            </section>
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium text-foreground">{t("infoPanel.properties")}</h2>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t("infoPanel.description")}
            </p>
          </div>
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {customProperties.length}
          </span>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-5 px-3 py-3">
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("infoPanel.custom")}
              </div>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("infoPanel.addProperty")}
                onClick={() => {
                  setEditingProperty(null)
                  setPropertyEditorOpen(true)
                }}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {customProperties.length > 0 ? (
              <div className="space-y-2">
                {customProperties.map((property) => (
                  <PropertyRow
                    key={property.id}
                    property={property}
                    onEdit={() => {
                      setEditingProperty(property)
                      setPropertyEditorOpen(true)
                    }}
                    onValueSave={async (updated) => {
                      await onUpsertCustomProperty?.(updated)
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                <Braces className="mx-auto size-4 text-muted-foreground" />
                <p className="mt-2 text-xs text-foreground">{t("infoPanel.noCustom")}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  {t("infoPanel.noDatabaseProperties")}
                </p>
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("infoPanel.nestedNotes")}
            </div>
            {nestedNotes.length ? (
              <div className="flex flex-wrap gap-1.5">
                {nestedNotes.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/40 px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                    onClick={() => onSelectLink?.(note.id)}
                  >
                    <span className="flex size-4 items-center justify-center" aria-hidden="true">
                      <IconValue
                        value={
                          note.icon && !["file", "supernote"].includes(note.icon)
                            ? note.icon
                            : undefined
                        }
                        fallback="📄"
                        className="size-4"
                      />
                    </span>
                    <span className="truncate">{note.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
                {t("infoPanel.noNestedNotes")}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-background/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left"
              aria-expanded={aboutOpen}
              onClick={() => setAboutOpen((open) => !open)}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("infoPanel.about")}
              </span>
              <ChevronDown
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  aboutOpen && "rotate-180",
                )}
              />
            </button>
            {aboutOpen && (
              <div className="divide-y divide-border border-t border-border text-[10px]">
                {[
                  [t("infoPanel.type"), properties.type],
                  [t("infoPanel.created"), properties.created || "—"],
                  [t("infoPanel.modified"), properties.modified || "—"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="truncate text-right text-foreground">{value}</span>
                  </div>
                ))}
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-muted-foreground">{t("infoPanel.id")}</span>
                  <code className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed text-foreground">
                    {properties.id}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyId(properties.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={t("infoPanel.copyId")}
                  >
                    {copied ? (
                      <Check className="size-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </div>
                {copied && (
                  <div className="px-3 pb-2 text-[10px] text-emerald-400">
                    {t("infoPanel.copied")}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
      <PropertyEditor
        property={editingProperty}
        open={propertyEditorOpen}
        onOpenChange={setPropertyEditorOpen}
        onSave={async (property) => {
          await onUpsertCustomProperty?.(property)
        }}
        onDelete={async (propertyId) => {
          await onDeleteCustomProperty?.(propertyId)
        }}
      />
    </div>
  )
}

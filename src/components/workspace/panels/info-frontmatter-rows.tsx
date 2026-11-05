import { parseOptions } from "../property-options"
import { PropertyOptionsEditor } from "./property-options-editor"
import { PROPERTY_TYPE_FALLBACKS, frontmatterPropertyIcon } from "./info-property-icons"
import { PropertyValueTextarea } from "./info-database-rows"
import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { Check, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { FrontmatterProperty } from "@/lib/storage"
import { IconValue } from "../icon-value"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"

function parseYamlList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    // A list that holds a comma in an item is written as JSON (З62).
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed.filter(Boolean)
      }
    } catch {
      /* a flow list in the YAML form below */
    }
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean)
  }
  const lines = trimmed.split("\n")
  const items: string[] = []
  let hasDash = false
  for (const line of lines) {
    const itemMatch = /^\s*-\s*(.+)$/u.exec(line)
    if (itemMatch) {
      hasDash = true
      items.push(itemMatch[1].trim().replace(/^['"]|['"]$/gu, ""))
    } else if (line.trim()) {
      items.push(line.trim().replace(/^['"]|['"]$/gu, ""))
    }
  }
  if (!hasDash && items.length === 1 && items[0].includes(",")) {
    return items[0]
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean)
  }
  return items.filter(Boolean)
}

/** The list as the text the backend turns into a YAML list; a comma inside an item needs JSON. */
function listValueText(items: string[]): string {
  return items.some((item) => /[,"[\]]/u.test(item)) ? JSON.stringify(items) : items.join(", ")
}

export function FrontmatterPropertyValue({
  property,
  propertyType,
  settings = "",
  onSave,
  onSaveList,
  disabled,
}: {
  property: FrontmatterProperty
  propertyType?: string
  settings?: string
  onSave?: (value: string) => Promise<void>
  /** A list is written as its items, never glued with commas (docs/sync-plan.md, З62). */
  onSaveList?: (items: string[]) => Promise<void>
  disabled?: boolean
}) {
  const effectiveType =
    propertyType ||
    (property.valueKind === "checkbox" || property.value === "true" || property.value === "false"
      ? "checkbox"
      : property.valueKind === "number"
        ? "number"
        : property.valueKind === "date"
          ? "date"
          : property.valueKind === "list"
            ? "list"
            : property.valueKind === "url" ||
                property.value.startsWith("http://") ||
                property.value.startsWith("https://")
              ? "url"
              : "text")

  async function commitValue(next: string) {
    try {
      await onSave?.(next)
    } catch {
      /* The panel displays the write failure. */
    }
  }
  const [value, setValue] = React.useState(property.value)
  const [isEditingList, setIsEditingList] = React.useState(false)
  React.useEffect(() => setValue(property.value), [property.value])

  const options = React.useMemo(() => {
    const list = parseOptions(settings).options
    if (value && !list.includes(value)) {
      list.unshift(value)
    }
    return list
  }, [settings, value])
  // The items of a list: from the header as they are; the text is only for the old payloads.
  const [localItems, setLocalItems] = React.useState<string[] | null>(null)
  React.useEffect(() => setLocalItems(null), [property.items, property.value])
  const currentItems = React.useMemo(
    () => localItems ?? (property.items?.length ? property.items : parseYamlList(value)),
    [localItems, property.items, value],
  )
  // The options of a multi-select, and the items of the list that are not among them (З62).
  const listOptions = React.useMemo(() => {
    const known = parseOptions(settings).options
    return [...currentItems.filter((item) => !known.includes(item)), ...known]
  }, [settings, currentItems])

  if (effectiveType === "checkbox") {
    const checked = value === "true"
    return (
      <div className="flex h-7 items-center px-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={property.key}
          disabled={disabled}
          onClick={async () => {
            const next = checked ? "false" : "true"
            setValue(next)
            await commitValue(next)
          }}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded border",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background hover:border-primary/50",
          )}
        >
          {checked && <Check className="size-3" />}
        </button>
      </div>
    )
  }

  if (effectiveType === "select") {
    return (
      <AmbySelect
        size="sm"
        variant="bare"
        value={value}
        disabled={disabled}
        aria-label={property.key}
        options={options.map((option) => ({ value: option, label: option }))}
        onValueChange={(next) => {
          setValue(next)
          void commitValue(next)
        }}
      />
    )
  }

  if (effectiveType === "number") {
    return (
      <input
        type="number"
        aria-label={property.key}
        step="any"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== property.value) void commitValue(value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setValue(property.value)
            event.currentTarget.blur()
          }
        }}
        className="amby-property-number h-7 w-full min-w-0 rounded-md bg-transparent px-1 font-mono text-xs tabular-nums text-foreground outline-none focus:bg-accent/40"
      />
    )
  }

  if (effectiveType === "date") {
    return (
      <input
        type="date"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== property.value) void commitValue(value)
        }}
        className="h-7 w-full min-w-0 rounded-md bg-transparent px-1 text-xs text-foreground outline-none focus:bg-accent/40"
      />
    )
  }

  if (effectiveType === "list" && parseOptions(settings).options.length > 0) {
    const chosen = currentItems
    return (
      <div
        role="group"
        aria-label={property.key}
        className="flex min-h-7 flex-wrap gap-1 px-1 py-1"
      >
        {listOptions.map((option) => {
          const on = chosen.includes(option)
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              aria-label={option}
              onClick={async () => {
                const next = on ? chosen.filter((item) => item !== option) : [...chosen, option]
                setLocalItems(next)
                if (onSaveList) {
                  try {
                    await onSaveList(next)
                  } catch {
                    /* The panel displays the write failure. */
                  }
                  return
                }
                const text = listValueText(next)
                setValue(text)
                await commitValue(text)
              }}
              className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium outline-none",
                on
                  ? "bg-secondary text-secondary-foreground"
                  : "border border-dashed border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              {option}
            </button>
          )
        })}
      </div>
    )
  }

  if (effectiveType === "list" && !isEditingList) {
    const items = parseYamlList(value)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsEditingList(true)}
        className="flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1 py-1 text-left text-xs outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        {items.length > 0 ? (
          items.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
            >
              {item}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </button>
    )
  }

  return (
    <PropertyValueTextarea
      value={value}
      initialValue={property.value}
      disabled={Boolean(disabled)}
      onChange={setValue}
      onSave={async () => {
        setIsEditingList(false)
        if (value !== property.value) await commitValue(value)
      }}
      onReset={() => {
        setValue(property.value)
        setIsEditingList(false)
      }}
    />
  )
}

export function FrontmatterPropertyRow({
  property,
  iconValue,
  propertyType = "text",
  settings = "",
  onIconChange,
  onRename,
  onChangeType,
  onChangeSettings,
  onSave,
  onSaveList,
  onDelete,
  disabled,
}: {
  property: FrontmatterProperty
  iconValue?: string
  propertyType?: string
  settings?: string
  onIconChange?: (icon: string) => Promise<void> | void
  onRename?: (name: string) => Promise<void> | void
  onChangeType?: (type: string) => Promise<void> | void
  onChangeSettings?: (settings: string) => Promise<void> | void
  onSaveList?: (items: string[]) => Promise<void>
  onSave?: (value: string) => Promise<void>
  onDelete?: () => Promise<void>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const PropertyIcon = frontmatterPropertyIcon(property, propertyType)
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(property.key)
  const [selectedType, setSelectedType] = React.useState(propertyType)
  const [settingsDraft, setSettingsDraft] = React.useState(settings)
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [currentIcon, setCurrentIcon] = React.useState(iconValue)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const iconButtonRef = React.useRef<HTMLButtonElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setCurrentIcon(iconValue)
  }, [iconValue])

  const handleSelectIcon = React.useCallback(
    (newIcon: string) => {
      setCurrentIcon(newIcon)
      setShowEmojiPicker(false)
      void Promise.resolve(onIconChange?.(newIcon)).catch(() => setCurrentIcon(iconValue))
    },
    [iconValue, onIconChange],
  )

  const handleClearIcon = React.useCallback(() => {
    setCurrentIcon("")
    setShowEmojiPicker(false)
    void Promise.resolve(onIconChange?.("")).catch(() => setCurrentIcon(iconValue))
  }, [iconValue, onIconChange])

  React.useEffect(() => {
    if (!popoverOpen) {
      setNameDraft(property.key)
      setSelectedType(propertyType)
      setSettingsDraft(settings)
      setShowEmojiPicker(false)
    } else {
      setSelectedType(propertyType)
      setSettingsDraft(settings)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [popoverOpen, property.key, propertyType, settings])

  // One rename at a time: the blur that follows Enter (the field is disabled while it goes on) and
  // the closing of the popover would otherwise send it again with the old name.
  const renaming = React.useRef(false)
  const commitRename = React.useCallback(async () => {
    if (renaming.current) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === property.key) {
      setNameDraft(property.key)
      return
    }
    renaming.current = true
    try {
      setIsRenaming(true)
      await onRename?.(trimmed)
    } catch {
      setNameDraft(property.key)
    } finally {
      renaming.current = false
      setIsRenaming(false)
    }
  }, [nameDraft, onRename, property.key])

  const handleTypeChange = React.useCallback(
    async (nextType: string) => {
      setSelectedType(nextType)
      try {
        await onChangeType?.(nextType)
      } catch {
        setSelectedType(propertyType)
      }
    },
    [onChangeType, propertyType],
  )

  const handleSettingsCommit = React.useCallback(async () => {
    if (settingsDraft !== settings) {
      try {
        await onChangeSettings?.(settingsDraft)
      } catch {
        setSettingsDraft(settings)
      }
    }
  }, [onChangeSettings, settings, settingsDraft])

  return (
    <div
      role="listitem"
      className="group/item relative grid min-h-8 grid-cols-[minmax(7rem,42%)_minmax(0,1fr)] items-start gap-1"
    >
      <div className="flex min-h-8 min-w-0 items-start py-0.5">
        <Popover
          open={popoverOpen}
          onOpenChange={(open) => {
            if (!open) {
              if (settingsDraft !== settings) {
                void handleSettingsCommit()
              }
              void commitRename()
            }
            setPopoverOpen(open)
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              disabled={disabled}
              className={cn(
                "group/property flex h-7 min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none",
                !disabled &&
                  "hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring cursor-pointer",
                popoverOpen && "bg-accent/60",
              )}
              title={property.key}
              aria-label={property.key}
            >
              <div className="flex size-4 shrink-0 items-center justify-center leading-none text-muted-foreground group-hover/property:text-foreground">
                <IconValue
                  value={currentIcon && currentIcon !== "◆" ? currentIcon : undefined}
                  fallback={<PropertyIcon className="size-3.5" aria-hidden="true" />}
                  className="size-3.5"
                />
              </div>
              <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground group-hover/property:text-foreground">
                {property.key}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            collisionPadding={16}
            className={cn(
              "z-50",
              showEmojiPicker
                ? "w-auto border-0 bg-transparent p-0 shadow-none"
                : "w-64 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg",
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape" && showEmojiPicker) {
                event.stopPropagation()
                event.preventDefault()
                setShowEmojiPicker(false)
              }
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {showEmojiPicker ? (
              <EmojiPickerPanel
                triggerRef={iconButtonRef}
                onSelect={(emoji) => handleSelectIcon(emoji.native)}
                onClear={handleClearIcon}
                clearLabel={t("tree.resetIcon")}
                onClose={() => setShowEmojiPicker(false)}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <button
                    ref={iconButtonRef}
                    type="button"
                    disabled={!onIconChange}
                    onClick={() => setShowEmojiPicker(true)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background hover:bg-accent cursor-pointer disabled:cursor-default"
                    title={t("infoPanel.propertyIcon")}
                    aria-label={t("infoPanel.propertyIcon")}
                  >
                    <IconValue
                      value={currentIcon && currentIcon !== "◆" ? currentIcon : undefined}
                      fallback={<PropertyIcon className="size-4" />}
                      className="size-4"
                    />
                  </button>
                  <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
                    <input
                      ref={inputRef}
                      value={nameDraft}
                      disabled={isRenaming}
                      aria-label={t("infoPanel.propertyName")}
                      className="min-w-0 flex-1 bg-transparent text-xs font-medium text-foreground outline-none disabled:opacity-60"
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void commitRename().then(() => setPopoverOpen(false))
                        }
                        if (e.key === "Escape") {
                          e.preventDefault()
                          setNameDraft(property.key)
                          setPopoverOpen(false)
                        }
                      }}
                    />
                  </div>
                </div>

                {onChangeType && (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <span className="text-[11px] text-muted-foreground">
                      {t("infoPanel.propertyType")}
                    </span>
                    <AmbySelect
                      size="sm"
                      className="w-32"
                      value={selectedType}
                      aria-label={t("infoPanel.propertyType")}
                      options={(
                        ["text", "number", "checkbox", "date", "select", "list", "url"] as const
                      ).map((type) => ({
                        value: type,
                        label: t(`infoPanel.propertyTypes.${type}`, {
                          defaultValue: PROPERTY_TYPE_FALLBACKS[type],
                        }),
                      }))}
                      onValueChange={(next) => void handleTypeChange(next)}
                    />
                  </div>
                )}

                {(selectedType === "select" || selectedType === "list") && (
                  <div className="px-1">
                    <PropertyOptionsEditor
                      settings={settingsDraft}
                      onChange={setSettingsDraft}
                      onCommit={(next) => {
                        // A select needs an option: an empty list is not sent (З62).
                        if (next && next !== settings)
                          void Promise.resolve(onChangeSettings?.(next))
                      }}
                    />
                  </div>
                )}

                {onDelete && (
                  <>
                    <div className="my-0.5 h-px bg-border" />
                    <button
                      type="button"
                      onClick={async () => {
                        setPopoverOpen(false)
                        try {
                          await onDelete()
                        } catch {
                          /* The panel displays the write failure. */
                        }
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 cursor-pointer"
                      title={t("infoPanel.deleteProperty")}
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t("infoPanel.deleteProperty")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <div className="min-h-8 min-w-0 px-1 py-0.5">
        <FrontmatterPropertyValue
          property={property}
          propertyType={propertyType}
          settings={settings}
          onSave={onSave}
          onSaveList={onSaveList}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

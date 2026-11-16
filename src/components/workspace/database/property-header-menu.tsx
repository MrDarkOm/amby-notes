import type { RenameOutcome } from "../file-actions/rename-outcome"
import * as React from "react"
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Check,
  ChevronRight,
  EyeOff,
  Info,
  ListFilter,
  Pin,
  PinOff,
  Repeat2,
  Settings2,
  Trash2,
  WrapText,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabasePropertySummary } from "@/lib/storage"
import { IconValue } from "../icon-value"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { PropertyTypeIcon as PropertyIcon } from "./property-type-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isEnterKey } from "@/lib/keyboard"

export function PropertyHeaderMenu({
  property,
  trigger,
  iconValue,
  onIconChange,
  onRename,
  onChangeType,
  settingsEditor,
  filterActive = false,
  sortDirection = null,
  canFilter = true,
  isFrozen = false,
  isWrapped = false,
  canWrap = false,
  onFilter,
  onSort,
  onToggleFreeze,
  onHide,
  onToggleWrap,
  onInsertLeft,
  onInsertRight,
  onDelete,
}: {
  property: DatabasePropertySummary
  trigger?: React.ReactNode
  iconValue?: string
  onIconChange?: (icon: string) => Promise<void> | void
  onRename: (name: string) => Promise<RenameOutcome | void> | void
  onChangeType?: (propertyType: string) => Promise<void> | void
  /** The settings of the property, shown in a submenu; `null` when it has none. */
  settingsEditor?: React.ReactNode
  filterActive?: boolean
  sortDirection?: "asc" | "desc" | null
  canFilter?: boolean
  isFrozen?: boolean
  isWrapped?: boolean
  canWrap?: boolean
  cursorText?: boolean
  onFilter?: () => void
  onSort?: (direction: "asc" | "desc" | null) => void
  onToggleFreeze?: () => void
  onHide?: () => void
  onToggleWrap?: () => void
  onInsertLeft?: () => void
  onInsertRight?: () => void
  onDelete?: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(property.name)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const committingRef = React.useRef(false)
  const iconTriggerRef = React.useRef<HTMLButtonElement>(null)
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const PropertyTypeIcon = React.useMemo(
    () => <PropertyIcon type={property.propertyType} />,
    [property.propertyType],
  )

  React.useEffect(() => {
    if (!open && !busy) setDraft(property.name)
  }, [busy, open, property.name])

  const commit = React.useCallback(async () => {
    if (committingRef.current) return
    const next = draft.trim()
    if (!next || next === property.name) {
      setDraft(property.name)
      return
    }
    committingRef.current = true
    setBusy(true)
    try {
      await onRename(next)
    } catch {
      setDraft(property.name)
    } finally {
      committingRef.current = false
      setBusy(false)
    }
  }, [draft, onRename, property.name])

  const focusName = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(draft.length, draft.length)
    })
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setDraft(property.name)
          focusName()
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-full min-w-0 w-full flex-1 cursor-pointer items-center justify-start gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-accent/40"
            title={property.name}
            aria-label={property.name}
            onClick={(event) => event.stopPropagation()}
          >
            <IconValue
              value={iconValue}
              fallback={<PropertyIcon type={property.propertyType} />}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{property.name}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={5}
        className="w-72 rounded-xl p-2"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          className="mb-1 flex items-center gap-2"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="relative shrink-0">
            <button
              ref={iconTriggerRef}
              type="button"
              disabled={!onIconChange}
              className="flex size-9 items-center justify-center rounded-lg border border-border bg-background hover:bg-accent disabled:cursor-default"
              title={t("databaseWorkspace.changeIcon")}
              aria-label={t("databaseWorkspace.changeIcon")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                if (onIconChange) setIconPickerOpen((current) => !current)
              }}
            >
              <IconValue value={iconValue} fallback={PropertyTypeIcon} className="size-4" />
            </button>
            {iconPickerOpen && onIconChange && (
              <div className="absolute left-0 top-full z-[100] mt-1">
                <EmojiPickerPanel
                  triggerRef={iconTriggerRef}
                  onSelect={(next) => {
                    void onIconChange(next.native)
                    setIconPickerOpen(false)
                  }}
                  onClear={() => {
                    void onIconChange("")
                    setIconPickerOpen(false)
                  }}
                  clearLabel={t("tree.resetIcon")}
                  onClose={() => setIconPickerOpen(false)}
                />
              </div>
            )}
          </div>
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-ring">
            <input
              ref={inputRef}
              value={draft}
              disabled={busy}
              aria-label={t("databaseWorkspace.propertyName")}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none disabled:opacity-60"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (isEnterKey(event)) {
                  event.preventDefault()
                  void commit().then(() => setOpen(false))
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  setDraft(property.name)
                  setOpen(false)
                }
              }}
            />
            <Info
              className="size-4 shrink-0 text-muted-foreground"
              aria-label={t("databaseTable.propertyInfo")}
            />
          </div>
        </div>

        {onChangeType && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="h-9 gap-2.5 rounded-lg px-2 text-sm">
              <Repeat2 />
              <span className="truncate">{t("databaseTable.changeType")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 rounded-xl p-1.5">
              {[
                "text",
                "number",
                "checkbox",
                "date",
                "url",
                "select",
                "multiSelect",
                "status",
                "formula",
                "relation",
              ].map((propertyType) => (
                <DropdownMenuItem
                  key={propertyType}
                  disabled={propertyType === property.propertyType || busy}
                  className="h-9 rounded-lg"
                  onSelect={() => void onChangeType(propertyType)}
                >
                  <PropertyIcon type={propertyType} />
                  <span className="flex-1 truncate">
                    {t(`databaseWorkspace.propertyTypes.${propertyType}`)}
                  </span>
                  {propertyType === property.propertyType && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {settingsEditor && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="h-9 gap-2.5 rounded-lg px-2 text-sm">
              <Settings2 />
              <span className="truncate">{t("databaseProperty.settings")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 rounded-xl p-3">
              {/* Typing in these fields must not reach the menu's own type-ahead and arrow keys. */}
              <div
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation()
                }}
              >
                {settingsEditor}
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ListFilter />}
          label={t("databaseTable.filterProperty")}
          active={filterActive}
          disabled={!onFilter || !canFilter}
          onSelect={() => {
            setOpen(false)
            onFilter?.()
          }}
        />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="h-9 gap-2.5 rounded-lg px-2 text-sm"
            disabled={!onSort}
          >
            <ArrowDownUp />
            <span className="truncate">{t("databaseTable.sortProperty")}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-xl p-1.5">
            <DropdownMenuItem className="h-9 rounded-lg" onSelect={() => onSort?.("asc")}>
              <ArrowUp className="size-4" />
              {t("databaseTable.sortAscending")}
              {sortDirection === "asc" && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-9 rounded-lg" onSelect={() => onSort?.("desc")}>
              <ArrowDown className="size-4" />
              {t("databaseTable.sortDescending")}
              {sortDirection === "desc" && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="h-9 rounded-lg"
              disabled={!sortDirection}
              onSelect={() => onSort?.(null)}
            >
              <X className="size-4" />
              {t("databaseTable.clearSort")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <PropertyMenuItem
          icon={isFrozen ? <PinOff /> : <Pin />}
          label={
            !onToggleFreeze
              ? `${t("databaseTable.freezeProperty")} · ${t("common.comingSoon")}`
              : isFrozen
                ? t("databaseTable.unfreezeProperty")
                : t("databaseTable.freezeProperty")
          }
          active={isFrozen}
          disabled={!onToggleFreeze}
          onSelect={onToggleFreeze}
        />
        <PropertyMenuItem
          icon={<EyeOff />}
          label={t("databaseTable.hideProperty")}
          disabled={!onHide}
          onSelect={onHide}
        />
        <PropertyMenuItem
          icon={<WrapText />}
          label={t("databaseTable.wrapProperty")}
          active={isWrapped}
          disabled={!canWrap || !onToggleWrap}
          onSelect={onToggleWrap}
        />

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ArrowLeftToLine />}
          label={t("databaseTable.insertPropertyLeft")}
          disabled={!onInsertLeft}
          onSelect={onInsertLeft}
        />
        <PropertyMenuItem
          icon={<ArrowRightToLine />}
          label={t("databaseTable.insertPropertyRight")}
          disabled={!onInsertRight}
          onSelect={onInsertRight}
        />
        <PropertyMenuItem
          icon={<Trash2 />}
          label={t("databaseTable.deleteProperty")}
          destructive
          disabled={!onDelete}
          onSelect={() => void onDelete?.()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PropertyMenuItem({
  icon,
  label,
  badge,
  chevron = false,
  active = false,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  badge?: string
  chevron?: boolean
  active?: boolean
  destructive?: boolean
  disabled?: boolean
  onSelect?: React.ComponentProps<typeof DropdownMenuItem>["onSelect"]
}) {
  return (
    <DropdownMenuItem
      className="h-9 gap-2.5 rounded-lg px-2 text-sm"
      variant={destructive ? "destructive" : "default"}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon}
      <span className="truncate">{label}</span>
      {badge && (
        <span className="ml-auto shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {badge}
        </span>
      )}
      {active && !chevron && <Check className="ml-auto size-4 text-primary" />}
      {chevron && <ChevronRight className={badge ? "size-4" : "ml-auto size-4"} />}
    </DropdownMenuItem>
  )
}

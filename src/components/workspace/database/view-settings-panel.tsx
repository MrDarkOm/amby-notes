"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { useTranslation } from "react-i18next"
import {
  ArrowDownUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  ImageIcon,
  Link,
  Lock,
  Plus,
  Search,
  Settings2,
  Trash2,
  Unlock,
  X,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { IconValue } from "@/components/workspace/icon-value"
import type { DatabasePropertySummary, DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { cardSpring } from "./database-motion"
import { IconPickerButton } from "./icon-picker-button"
import { AmbySelect } from "@/components/ui/amby-select"
import { PropertyTypeIcon } from "./property-type-icon"
import { CardTitleInput } from "./layouts/card-title-input"
import { getViewLayoutIcon } from "./database-layout-icons"
import type { CardSize } from "./view-config"

/** Width of the panel. */
const PANEL_WIDTH = 288

type Page = "root" | "layout" | "properties" | "openMode" | "group" | "editProperties" | "property"

/** Pages slide in from the side they are reached from, and out the other way. */
const pageVariants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 28 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -28 }),
}

/** Types a property can be changed to (Rollup is made, not converted to). */
const PROPERTY_TYPES = [
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
]

const LAYOUTS = ["table", "board", "list", "gallery", "chart"] as const
const OPEN_MODES = ["sidePeek", "centerPeek", "fullPage"] as const
const CARD_SIZES: CardSize[] = ["small", "medium", "large"]

export interface ViewSettingsPanelProps {
  /** A narrow workspace: the toolbar is folded away, so the panel also offers its actions. */
  isCompactToolbar: boolean
  isDatabaseLocked: boolean
  vaultGeneration: number | null
  activeView: DatabaseViewSummary | undefined
  database: DatabaseSummary | null | undefined
  mutationBusy: boolean
  searchOpen: boolean
  isLinkCopied: boolean
  activeHiddenPropertyIds: Set<string>
  cardSize: CardSize
  openMode: string
  onOpenModeChange: (mode: string) => void
  onCardSizeChange: (size: CardSize) => void
  /** Board: the property whose values are the columns; `null` is no grouping. */
  groupPropertyId: string | null
  onGroupPropertyChange: (propertyId: string | null) => void
  /** Gallery: whether cards show a cover image. */
  coverVisible: boolean
  onCoverVisibleChange: (visible: boolean) => void
  filterCount: number
  sortCount: number
  onOpenFilter: () => void
  onOpenSort: () => void
  openRowDialog: (
    opts: { kind: "default" | "empty" } | { kind: "template"; templateId: string },
  ) => void
  onToggleSearch: () => void
  /** Icon chosen for the view; empty for the layout's own icon. */
  viewIcon?: string
  onViewIconChange: (icon: string) => void
  onRenameView: (name: string) => Promise<void> | void
  changeActiveViewLayout: (layout: (typeof LAYOUTS)[number]) => void | Promise<void>
  setViewHiddenPropertyIds: (viewId: string, hidden: Set<string>) => void
  togglePropertyVisibility: (propertyId: string) => void
  onOpenAddProperty: () => void
  copyLinkToView: () => void | Promise<void>
  handleToggleLock: () => void
  mutateView: (action: "duplicate" | "delete", viewId: string) => void | Promise<void>
  /** The settings of a property (options, formats, ...) as the property menu shows them. */
  renderPropertySettings: (property: DatabasePropertySummary) => React.ReactNode
  propertyIconOf: (propertyId: string) => string | undefined
  onPropertyIconChange: (propertyId: string, icon: string) => void
  onRenameProperty: (propertyId: string, name: string) => Promise<void> | void
  onChangePropertyType: (propertyId: string, propertyType: string) => Promise<void> | void
  onDeleteProperty: (propertyId: string) => Promise<void> | void
  /** Changes when the name of the view should take focus (Rename in the view's menu). */
  focusNameSignal?: number
  /** Distance from the top of the area the panel floats in, so it starts below the toolbar. */
  top: number
  onClose: () => void
}

/** A settings row: icon, label, current value, and a chevron when it opens a page. */
function Row({
  icon,
  label,
  value,
  onClick,
  disabled,
  chevron,
  trailing,
  danger,
}: {
  icon: React.ReactNode
  label: string
  value?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  chevron?: boolean
  trailing?: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        danger && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4",
          danger && "text-destructive",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined && (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{value}</span>
      )}
      {trailing}
      {chevron && <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />}
    </button>
  )
}

/** A group of rows; a divider line separates it from the group above. */
function Section({ divider, children }: { divider?: boolean; children: React.ReactNode }) {
  return (
    <section
      className={cn("space-y-0.5 pb-1.5", divider && "mt-0.5 border-t border-border/60 pt-1.5")}
    >
      {children}
    </section>
  )
}

/** A choice in a list page: a label, an optional description and a check on the chosen one. */
function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        selected && "bg-primary/10",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{label}</span>
        {description && (
          <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
        )}
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  )
}

/** A property with an on/off switch. */
function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 hover:bg-accent">
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * The settings of the active view as a panel beside the view, in the style of a
 * side sheet: it stays open while the layout changes, and its pages (layout,
 * properties, open mode, columns, card properties) slide in over the main list
 * with a Back button. Only what the layout needs is shown.
 */
export function ViewSettingsPanel({
  isCompactToolbar,
  isDatabaseLocked,
  vaultGeneration,
  activeView,
  database,
  mutationBusy,
  searchOpen,
  isLinkCopied,
  activeHiddenPropertyIds,
  cardSize,
  openMode,
  onOpenModeChange,
  onCardSizeChange,
  groupPropertyId,
  onGroupPropertyChange,
  coverVisible,
  onCoverVisibleChange,
  filterCount,
  sortCount,
  onOpenFilter,
  onOpenSort,
  openRowDialog,
  onToggleSearch,
  viewIcon,
  onViewIconChange,
  onRenameView,
  changeActiveViewLayout,
  setViewHiddenPropertyIds,
  togglePropertyVisibility,
  onOpenAddProperty,
  copyLinkToView,
  handleToggleLock,
  mutateView,
  renderPropertySettings,
  propertyIconOf,
  onPropertyIconChange,
  onRenameProperty,
  onChangePropertyType,
  onDeleteProperty,
  focusNameSignal = 0,
  top,
  onClose,
}: ViewSettingsPanelProps) {
  const { t } = useTranslation()
  const [page, setPage] = React.useState<Page>("root")
  const [direction, setDirection] = React.useState<1 | -1>(1)
  const nameRef = React.useRef<HTMLInputElement>(null)
  // Rename from the view's menu: show the list (where the name is) and put the cursor in the name.
  React.useEffect(() => {
    if (!focusNameSignal) return
    setDirection(-1)
    setPage("root")
    const focusName = () => {
      const input = nameRef.current
      if (!input || document.activeElement === input) return
      input.focus()
      input.select()
    }
    // The page may still be sliding in, and a menu that has just closed may hand focus back
    // to its trigger, so the focus is taken again a moment later if it was lost.
    const frame = requestAnimationFrame(focusName)
    const later = setTimeout(focusName, 180)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(later)
    }
  }, [focusNameSignal])
  const [editedPropertyId, setEditedPropertyId] = React.useState<string | null>(null)
  const go = (next: Page, back = false) => {
    setDirection(back ? -1 : 1)
    setPage(next)
  }
  // One step back: a property returns to the list of properties, every other page to the list.
  const back = () => go(page === "property" ? "editProperties" : "root", true)

  const layout = activeView?.layout ?? "table"
  const LayoutIcon = getViewLayoutIcon(layout)
  const properties = database?.properties ?? []
  const visibleCount = properties.filter((p) => !activeHiddenPropertyIds.has(p.propertyId)).length
  const groupable = properties.filter((p) => ["select", "status"].includes(p.propertyType))
  const groupName = properties.find((p) => p.propertyId === groupPropertyId)?.name
  const locked = isDatabaseLocked || vaultGeneration === null

  // A page that does not apply to the layout (after switching it) goes back to the list.
  React.useEffect(() => {
    if (page === "group" && layout !== "board") {
      setDirection(-1)
      setPage("root")
    }
  }, [layout, page])

  const editedProperty = properties.find((property) => property.propertyId === editedPropertyId)
  // A property that is gone (deleted here or elsewhere) leaves its page.
  React.useEffect(() => {
    if (page === "property" && !editedProperty) {
      setDirection(-1)
      setPage("editProperties")
    }
  }, [editedProperty, page])

  const titles: Record<Page, string> = {
    root: t("databaseSettings.title"),
    layout: t("databaseWorkspace.layout"),
    properties: t("databaseWorkspace.propertyVisibility"),
    openMode: t("databaseWorkspace.openMode"),
    group: t("databaseWorkspace.groupBy"),
    editProperties: t("databaseProperty.editProperties"),
    property: editedProperty?.name ?? t("databaseProperty.editProperties"),
  }

  const renderPage = () => {
    switch (page) {
      case "layout":
        return (
          <div role="radiogroup" aria-label={titles.layout} className="grid grid-cols-2 gap-2 p-1">
            {LAYOUTS.map((candidate) => {
              const Icon = getViewLayoutIcon(candidate)
              const active = layout === candidate
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={locked || mutationBusy}
                  onClick={() => void changeActiveViewLayout(candidate)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border px-3 py-3 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/70 text-foreground",
                  )}
                >
                  <Icon className="size-5" />
                  {t(`databaseLayouts.${candidate}`)}
                </button>
              )
            })}
          </div>
        )
      case "properties":
        return (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between px-2.5 pb-1 text-xs text-muted-foreground">
              <span>
                {visibleCount}/{properties.length}
              </span>
              {properties.length > 1 && activeView && (
                <span className="flex gap-3">
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => setViewHiddenPropertyIds(activeView.viewId, new Set())}
                  >
                    {t("databaseWorkspace.showAllProperties")}
                  </button>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() =>
                      setViewHiddenPropertyIds(
                        activeView.viewId,
                        new Set(properties.map((property) => property.propertyId)),
                      )
                    }
                  >
                    {t("databaseWorkspace.hideAllProperties")}
                  </button>
                </span>
              )}
            </div>
            {properties.map((property) => (
              <SwitchRow
                key={property.propertyId}
                label={property.name}
                checked={!activeHiddenPropertyIds.has(property.propertyId)}
                onChange={() => togglePropertyVisibility(property.propertyId)}
              />
            ))}
            {properties.length === 0 && (
              <p className="px-2.5 py-2 text-sm text-muted-foreground">
                {t("databaseWorkspace.noProperties")}
              </p>
            )}
            <div className="pt-2">
              <Row
                icon={<Plus />}
                label={t("databaseWorkspace.addProperty")}
                disabled={locked}
                onClick={onOpenAddProperty}
              />
            </div>
          </div>
        )
      case "openMode":
        return (
          <div role="radiogroup" aria-label={titles.openMode} className="space-y-0.5">
            {OPEN_MODES.map((mode) => (
              <ChoiceRow
                key={mode}
                label={t(`databaseWorkspace.openModes.${mode}`)}
                description={t(`databaseSettings.openModeHints.${mode}`)}
                selected={openMode === mode}
                disabled={isDatabaseLocked}
                onClick={() => onOpenModeChange(mode)}
              />
            ))}
          </div>
        )
      case "group":
        return (
          <div role="radiogroup" aria-label={titles.group} className="space-y-0.5">
            <ChoiceRow
              label={t("databaseWorkspace.groupByNone")}
              selected={groupPropertyId === null}
              disabled={isDatabaseLocked}
              onClick={() => onGroupPropertyChange(null)}
            />
            {groupable.map((property) => (
              <ChoiceRow
                key={property.propertyId}
                label={property.name}
                selected={groupPropertyId === property.propertyId}
                disabled={isDatabaseLocked}
                onClick={() => onGroupPropertyChange(property.propertyId)}
              />
            ))}
            {groupable.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                {t("databaseWorkspace.groupByHint")}
              </p>
            )}
          </div>
        )
      case "editProperties":
        return (
          <div className="space-y-0.5">
            <p className="px-2.5 pb-1.5 text-xs leading-snug text-muted-foreground">
              {t("databaseProperty.editPropertiesHint")}
            </p>
            {properties.map((property) => (
              <Row
                key={property.propertyId}
                icon={
                  <IconValue
                    value={propertyIconOf(property.propertyId)}
                    fallback={<PropertyTypeIcon type={property.propertyType} />}
                  />
                }
                label={property.name}
                value={t(`databaseWorkspace.propertyTypes.${property.propertyType}`, {
                  defaultValue: property.propertyType,
                })}
                chevron
                onClick={() => {
                  setEditedPropertyId(property.propertyId)
                  go("property")
                }}
              />
            ))}
            {properties.length === 0 && (
              <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
                {t("databaseWorkspace.noProperties")}
              </p>
            )}
            <div className="pt-2">
              <Row
                icon={<Plus />}
                label={t("databaseWorkspace.addProperty")}
                disabled={locked}
                onClick={onOpenAddProperty}
              />
            </div>
          </div>
        )
      case "property": {
        if (!editedProperty) return null
        const settings = renderPropertySettings(editedProperty)
        const visible = !activeHiddenPropertyIds.has(editedProperty.propertyId)
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <IconPickerButton
                value={propertyIconOf(editedProperty.propertyId)}
                fallback={<PropertyTypeIcon type={editedProperty.propertyType} />}
                label={t("databaseProperty.changeIcon")}
                disabled={locked}
                onChange={(icon) => onPropertyIconChange(editedProperty.propertyId, icon)}
                className="size-8 rounded-md border border-border bg-background"
                iconClassName="size-4"
              />
              <CardTitleInput
                value={editedProperty.name}
                label={t("databaseProperty.name")}
                onCommit={(name) => onRenameProperty(editedProperty.propertyId, name)}
                className="h-8 flex-1 rounded-md bg-background px-2 text-[13px] font-medium"
              />
            </div>
            <div className="space-y-1">
              <span className="px-0.5 text-[11px] font-medium text-muted-foreground">
                {t("databaseProperty.type")}
              </span>
              <AmbySelect
                value={editedProperty.propertyType}
                disabled={locked}
                aria-label={t("databaseProperty.type")}
                options={[
                  ...PROPERTY_TYPES.map((type) => ({
                    value: type,
                    label: t(`databaseWorkspace.propertyTypes.${type}`),
                  })),
                  ...(PROPERTY_TYPES.includes(editedProperty.propertyType)
                    ? []
                    : [{ value: editedProperty.propertyType, label: editedProperty.propertyType }]),
                ]}
                onValueChange={(type) => void onChangePropertyType(editedProperty.propertyId, type)}
              />
            </div>
            {settings && <div className="border-t border-border/60 pt-2">{settings}</div>}
            <SwitchRow
              label={t("databaseProperty.showInView")}
              checked={visible}
              onChange={() => togglePropertyVisibility(editedProperty.propertyId)}
            />
            <div className="border-t border-border/60 pt-1.5">
              <Row
                icon={<Trash2 />}
                danger
                label={t("databaseProperty.delete")}
                disabled={locked}
                onClick={() => {
                  void Promise.resolve(onDeleteProperty(editedProperty.propertyId))
                }}
              />
            </div>
          </div>
        )
      }
      default:
        return null
    }
  }

  const renderRoot = () => (
    <div>
      {isCompactToolbar && (
        <Section>
          <Row
            icon={<Plus />}
            label={t("databaseWorkspace.newPage")}
            disabled={locked}
            onClick={() => openRowDialog({ kind: "default" })}
          />
          {(database?.templates ?? []).map((template) => (
            <Row
              key={template.templateId}
              icon={<FileText />}
              label={template.name}
              disabled={locked}
              onClick={() => openRowDialog({ kind: "template", templateId: template.templateId })}
            />
          ))}
          <Row
            icon={searchOpen ? <X /> : <Search />}
            label={searchOpen ? t("databaseWorkspace.closeSearch") : t("databaseWorkspace.search")}
            onClick={onToggleSearch}
          />
        </Section>
      )}

      {activeView && (
        <div className="flex items-center gap-1.5 pb-1.5 pt-0.5">
          <IconPickerButton
            value={viewIcon}
            fallback={<LayoutIcon className="size-4 text-muted-foreground" />}
            label={t("databaseSettings.changeViewIcon")}
            disabled={isDatabaseLocked}
            onChange={onViewIconChange}
            className="size-8 rounded-md border border-border bg-background"
            iconClassName="size-4"
          />
          <CardTitleInput
            value={activeView.title}
            label={t("databaseWorkspace.viewName")}
            inputRef={nameRef}
            onCommit={onRenameView}
            className="h-8 flex-1 rounded-md bg-background px-2 text-[13px] font-medium"
          />
        </div>
      )}

      {activeView && (
        <Section divider>
          <Row
            icon={<LayoutIcon />}
            label={t("databaseWorkspace.layout")}
            value={t(`databaseLayouts.${layout}`)}
            chevron
            onClick={() => go("layout")}
          />
          <Row
            icon={<Eye />}
            label={t("databaseWorkspace.propertyVisibility")}
            value={`${visibleCount}/${properties.length}`}
            chevron
            onClick={() => go("properties")}
          />
          {layout === "board" && (
            <Row
              icon={<Columns3 />}
              label={t("databaseWorkspace.groupBy")}
              value={groupName ?? t("databaseWorkspace.groupByNone")}
              chevron
              onClick={() => go("group")}
            />
          )}
          {layout === "gallery" && (
            <>
              <div className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 hover:bg-accent">
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {t("databaseWorkspace.galleryCover")}
                </span>
                <Switch
                  checked={coverVisible}
                  disabled={isDatabaseLocked}
                  aria-label={t("databaseWorkspace.galleryCover")}
                  onCheckedChange={onCoverVisibleChange}
                />
              </div>
              <div className="flex h-8 items-center gap-2.5 rounded-lg px-2.5">
                <span className="min-w-0 flex-1 truncate pl-[1.625rem] text-[13px]">
                  {t("databaseWorkspace.cardSize")}
                </span>
                <div
                  role="radiogroup"
                  aria-label={t("databaseWorkspace.cardSize")}
                  className="flex rounded-lg bg-muted/60 p-0.5"
                >
                  {CARD_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      role="radio"
                      aria-checked={cardSize === size}
                      disabled={isDatabaseLocked}
                      onClick={() => onCardSizeChange(size)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                        cardSize === size
                          ? "bg-background font-medium shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`databaseWorkspace.cardSizes.${size}`)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <Row
            icon={<Settings2 />}
            label={t("databaseProperty.editProperties")}
            chevron
            onClick={() => go("editProperties")}
          />
          <Row
            icon={<ExternalLink />}
            label={t("databaseWorkspace.openMode")}
            value={t(`databaseWorkspace.openModes.${openMode}`, {
              defaultValue: t("databaseWorkspace.openModes.sidePeek"),
            })}
            chevron
            onClick={() => go("openMode")}
          />
          <Row
            icon={<Filter />}
            label={t("databaseWorkspace.filter")}
            value={filterCount > 0 ? filterCount : undefined}
            onClick={onOpenFilter}
          />
          <Row
            icon={<ArrowDownUp />}
            label={t("databaseWorkspace.sort")}
            value={sortCount > 0 ? sortCount : undefined}
            onClick={onOpenSort}
          />
        </Section>
      )}

      <Section divider>
        {activeView && (
          <Row
            icon={isLinkCopied ? <Check className="text-primary" /> : <Link />}
            label={
              isLinkCopied
                ? t("databaseWorkspace.linkCopied")
                : t("databaseWorkspace.copyLinkToView")
            }
            onClick={() => void copyLinkToView()}
          />
        )}
        <Row
          icon={isDatabaseLocked ? <Lock className="text-amber-500" /> : <Unlock />}
          label={
            isDatabaseLocked
              ? t("databaseWorkspace.unlockDatabase")
              : t("databaseWorkspace.lockDatabase")
          }
          onClick={handleToggleLock}
        />
      </Section>

      {activeView && (
        <Section divider>
          <Row
            icon={<Copy />}
            label={t("databaseWorkspace.duplicateView")}
            disabled={locked || mutationBusy}
            onClick={() => void mutateView("duplicate", activeView.viewId)}
          />
          <Row
            icon={<Trash2 />}
            danger
            label={t("databaseWorkspace.deleteView")}
            disabled={locked || mutationBusy || (database?.views.length ?? 0) <= 1}
            onClick={() => void mutateView("delete", activeView.viewId)}
          />
        </Section>
      )}
    </div>
  )

  return (
    <motion.aside
      aria-label={t("databaseSettings.title")}
      // Floats over the view, between the toolbar above and the status bar below.
      className="absolute bottom-14 right-2 z-30 max-w-[calc(100%-1rem)]"
      style={{ width: PANEL_WIDTH, top }}
      initial={{ opacity: 0, x: 28, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, scale: 0.98 }}
      transition={motionTransition(motionTransitions.panel)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.stopPropagation()
        if (page === "root") onClose()
        else back()
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground shadow-md">
        <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          {page !== "root" && (
            <button
              type="button"
              aria-label={t("databaseSettings.back")}
              title={t("databaseSettings.back")}
              onClick={back}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <h2
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] font-semibold",
              page === "root" && "pl-2",
            )}
          >
            {titles[page]}
          </h2>
          <button
            type="button"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={page}
              custom={direction}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={motionTransition({ ...cardSpring, opacity: motionTransitions.fast })}
              className="pt-2"
            >
              {page === "root" ? renderRoot() : renderPage()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  )
}

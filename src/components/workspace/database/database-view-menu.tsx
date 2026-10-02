"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDownUp,
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Layers,
  LayoutGrid,
  Link,
  Lock,
  Palette,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  Unlock,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CardSize } from "./view-config"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { getViewLayoutIcon } from "./database-layout-icons"

/** A toolbar toggle for the filter or sort panel, with a badge for active rules. */
export function QueryPanelButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="relative size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-3.5 text-primary-foreground">
          {count}
        </span>
      )}
    </Button>
  )
}

export interface DatabaseSettingsMenuContentProps {
  isCompactToolbar: boolean
  isDatabaseLocked: boolean
  vaultGeneration: number | null
  activeView: DatabaseViewSummary | undefined
  database: DatabaseSummary | null | undefined
  mutationBusy: boolean
  searchOpen: boolean
  isLinkCopied: boolean
  activeHiddenPropertyIds: Set<string>
  cardFields: string[] | null
  cardSize: CardSize
  onCardFieldsChange: (fields: string[] | null) => void
  onCardSizeChange: (size: CardSize) => void
  filterCount: number
  sortCount: number
  onOpenFilter: () => void
  onOpenSort: () => void
  openRowDialog: (
    opts: { kind: "default" | "empty" } | { kind: "template"; templateId: string },
  ) => void
  onToggleSearch: () => void
  openRenameViewDialog: (view: DatabaseViewSummary) => void
  changeActiveViewLayout: (
    layout: "table" | "board" | "list" | "gallery" | "chart",
  ) => void | Promise<void>
  setViewHiddenPropertyIds: (viewId: string, hidden: Set<string>) => void
  togglePropertyVisibility: (propertyId: string) => void
  onOpenAddProperty: () => void
  copyLinkToView: () => void | Promise<void>
  handleToggleLock: () => void
  mutateView: (action: "duplicate" | "delete", viewId: string) => void | Promise<void>
}

export function DatabaseSettingsMenuContent({
  isCompactToolbar,
  isDatabaseLocked,
  vaultGeneration,
  activeView,
  database,
  mutationBusy,
  searchOpen,
  isLinkCopied,
  activeHiddenPropertyIds,
  cardFields,
  cardSize,
  onCardFieldsChange,
  onCardSizeChange,
  filterCount,
  sortCount,
  onOpenFilter,
  onOpenSort,
  openRowDialog,
  onToggleSearch,
  openRenameViewDialog,
  changeActiveViewLayout,
  setViewHiddenPropertyIds,
  togglePropertyVisibility,
  onOpenAddProperty,
  copyLinkToView,
  handleToggleLock,
  mutateView,
}: DatabaseSettingsMenuContentProps) {
  const { t } = useTranslation()
  const ActiveViewLayoutIcon = activeView ? getViewLayoutIcon(activeView.layout) : Table2
  const allProperties = database?.properties ?? []
  const visiblePropertiesCount = allProperties.filter(
    (prop) => !activeHiddenPropertyIds.has(prop.propertyId),
  ).length

  return (
    <DropdownMenuContent align="end" className="w-60">
      {/* 1. (Новая, Шаблоны, Поиск) - only in compact mode */}
      {isCompactToolbar && (
        <>
          <DropdownMenuItem
            disabled={isDatabaseLocked || vaultGeneration === null}
            onSelect={() => openRowDialog({ kind: "default" })}
          >
            <Plus className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.newPage")}</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={isDatabaseLocked || vaultGeneration === null}>
              <FileText className="size-4" />
              <span className="flex-1">{t("databaseWorkspace.templates")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuItem onSelect={() => openRowDialog({ kind: "default" })}>
                <Database className="size-4" />
                <span>{t("databaseWorkspace.defaultTemplate")}</span>
              </DropdownMenuItem>
              {database?.templates.map((template) => (
                <DropdownMenuItem
                  key={template.templateId}
                  onSelect={() =>
                    openRowDialog({ kind: "template", templateId: template.templateId })
                  }
                >
                  <FileText className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{template.name}</span>
                </DropdownMenuItem>
              ))}
              {(!database || database.templates.length === 0) && (
                <DropdownMenuItem disabled>{t("databaseWorkspace.noTemplates")}</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openRowDialog({ kind: "empty" })}>
                <Plus className="size-4" />
                <span>{t("databaseWorkspace.createTemplate")}</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onToggleSearch}>
            {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
            <span className="flex-1">
              {searchOpen ? t("databaseWorkspace.closeSearch") : t("databaseWorkspace.search")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}

      {/* 2. Иконка текущего представления и Название */}
      {activeView && (
        <DropdownMenuItem
          onSelect={() => openRenameViewDialog(activeView)}
          className="flex items-center gap-2 font-medium"
        >
          <ActiveViewLayoutIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{activeView.title}</span>
          <Pencil className="size-3 text-muted-foreground opacity-60 shrink-0" />
        </DropdownMenuItem>
      )}

      <DropdownMenuSeparator />

      {/* 3. Тип текущего представления (Раскладка) */}
      {activeView && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ActiveViewLayoutIcon className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.layout")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {t(`databaseLayouts.${activeView.layout}`)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            {(["table", "board", "list", "gallery", "chart"] as const).map((layout) => {
              const LayoutIcon = getViewLayoutIcon(layout)
              const isActive = activeView.layout === layout
              return (
                <DropdownMenuItem
                  key={layout}
                  disabled={isDatabaseLocked || vaultGeneration === null || mutationBusy}
                  onSelect={() => void changeActiveViewLayout(layout)}
                  className={cn(isActive && "font-medium")}
                >
                  <LayoutIcon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{t(`databaseLayouts.${layout}`)}</span>
                  {isActive && <Check className="size-4 text-primary" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {/* 4. Видимые свойства */}
      {activeView && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Eye className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.propertyVisibility")}</span>
            <span className="ml-auto text-xs text-muted-foreground">{visiblePropertiesCount}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 max-h-80 overflow-y-auto">
            <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
              <span>{t("databaseWorkspace.propertyVisibility")}</span>
              <span>
                {visiblePropertiesCount}/{allProperties.length}
              </span>
            </div>
            {allProperties.length > 1 && (
              <>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setViewHiddenPropertyIds(activeView.viewId, new Set())
                  }}
                >
                  <Eye className="size-4" />
                  {t("databaseWorkspace.showAllProperties")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setViewHiddenPropertyIds(
                      activeView.viewId,
                      new Set(allProperties.map((property) => property.propertyId)),
                    )
                  }}
                >
                  <EyeOff className="size-4" />
                  {t("databaseWorkspace.hideAllProperties")}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            {allProperties.map((property) => {
              const isVisible = !activeHiddenPropertyIds.has(property.propertyId)
              return (
                <DropdownMenuItem
                  key={property.propertyId}
                  onSelect={(e) => {
                    e.preventDefault()
                    togglePropertyVisibility(property.propertyId)
                  }}
                  className="flex items-center gap-2"
                >
                  {isVisible ? (
                    <Eye className="size-4 text-primary shrink-0" />
                  ) : (
                    <EyeOff className="size-4 text-muted-foreground shrink-0" />
                  )}
                  <span
                    className={cn(
                      "flex-1 truncate",
                      !isVisible && "text-muted-foreground line-through opacity-75",
                    )}
                  >
                    {property.name}
                  </span>
                </DropdownMenuItem>
              )
            })}
            {allProperties.length === 0 && (
              <DropdownMenuItem disabled>{t("databaseWorkspace.noProperties")}</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isDatabaseLocked || vaultGeneration === null}
              onSelect={onOpenAddProperty}
            >
              <Plus className="size-4" />
              <span>{t("databaseWorkspace.addProperty")}</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {/* 4b. Поля карточек (board, list, gallery) */}
      {activeView && ["board", "list", "gallery"].includes(activeView.layout) && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <LayoutGrid className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.cardFields")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {cardFields === null ? t("databaseWorkspace.cardFieldsAuto") : cardFields.length}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 max-h-80 overflow-y-auto">
            <DropdownMenuItem
              disabled={isDatabaseLocked}
              onSelect={(event) => {
                event.preventDefault()
                onCardFieldsChange(null)
              }}
            >
              <span className="flex-1">{t("databaseWorkspace.cardFieldsAuto")}</span>
              {cardFields === null && <Check className="size-4 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {allProperties.map((property) => {
              const checked = cardFields?.includes(property.propertyId) ?? false
              return (
                <DropdownMenuItem
                  key={property.propertyId}
                  disabled={isDatabaseLocked}
                  onSelect={(event) => {
                    event.preventDefault()
                    const selected = new Set(cardFields ?? [])
                    if (checked) selected.delete(property.propertyId)
                    else selected.add(property.propertyId)
                    // Keep the schema order, whatever order they were ticked in.
                    onCardFieldsChange(
                      allProperties
                        .map((candidate) => candidate.propertyId)
                        .filter((id) => selected.has(id)),
                    )
                  }}
                >
                  <span className="flex-1 truncate">{property.name}</span>
                  {checked && <Check className="size-4 text-primary" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {activeView?.layout === "gallery" && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <LayoutGrid className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.cardSize")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {t(`databaseWorkspace.cardSizes.${cardSize}`)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {(["small", "medium", "large"] as const).map((size) => (
              <DropdownMenuItem
                key={size}
                disabled={isDatabaseLocked}
                onSelect={() => onCardSizeChange(size)}
              >
                <span className="flex-1">{t(`databaseWorkspace.cardSizes.${size}`)}</span>
                {cardSize === size && <Check className="size-4 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {/* 5. Фильтр */}
      <DropdownMenuItem onSelect={onOpenFilter}>
        <Filter className="size-4" />
        <span className="flex-1">{t("databaseWorkspace.filter")}</span>
        {filterCount > 0 && (
          <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {filterCount}
          </span>
        )}
      </DropdownMenuItem>

      {/* 6. Сортировка */}
      <DropdownMenuItem onSelect={onOpenSort}>
        <ArrowDownUp className="size-4" />
        <span className="flex-1">{t("databaseWorkspace.sort")}</span>
        {sortCount > 0 && (
          <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {sortCount}
          </span>
        )}
      </DropdownMenuItem>

      {/* 7. Группировать (Заглушка) */}
      <DropdownMenuItem disabled className="opacity-60 cursor-not-allowed">
        <Layers className="size-4" />
        <span className="flex-1">{t("databaseWorkspace.group")}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("databaseWorkspace.comingSoon")}
        </span>
      </DropdownMenuItem>

      {/* 8. Цвета (Заглушка) */}
      <DropdownMenuItem disabled className="opacity-60 cursor-not-allowed">
        <Palette className="size-4" />
        <span className="flex-1">{t("databaseWorkspace.conditionalColor")}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("databaseWorkspace.comingSoon")}
        </span>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      {/* 9. Копировать ссылку на представление */}
      {activeView && (
        <DropdownMenuItem onSelect={() => void copyLinkToView()}>
          {isLinkCopied ? (
            <>
              <Check className="size-4 text-primary" />
              <span className="flex-1 text-primary">{t("databaseWorkspace.linkCopied")}</span>
            </>
          ) : (
            <>
              <Link className="size-4" />
              <span>{t("databaseWorkspace.copyLinkToView")}</span>
            </>
          )}
        </DropdownMenuItem>
      )}

      {/* 10. Заблокировать базу */}
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault()
          handleToggleLock()
        }}
      >
        {isDatabaseLocked ? (
          <>
            <Lock className="size-4 text-amber-600 dark:text-amber-500" />
            <span className="flex-1">{t("databaseWorkspace.unlockDatabase")}</span>
            <Check className="size-4 text-primary" />
          </>
        ) : (
          <>
            <Unlock className="size-4" />
            <span className="flex-1">{t("databaseWorkspace.lockDatabase")}</span>
          </>
        )}
      </DropdownMenuItem>

      {/* Duplicate / Delete view */}
      {activeView && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isDatabaseLocked || vaultGeneration === null || mutationBusy}
            onSelect={() => void mutateView("duplicate", activeView.viewId)}
          >
            <Copy className="size-4" />
            <span>{t("databaseWorkspace.duplicateView")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={
              isDatabaseLocked ||
              vaultGeneration === null ||
              mutationBusy ||
              (database?.views.length ?? 0) <= 1
            }
            onSelect={() => void mutateView("delete", activeView.viewId)}
          >
            <Trash2 className="size-4" />
            <span>{t("databaseWorkspace.deleteView")}</span>
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  )
}

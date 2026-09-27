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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { getViewLayoutIcon } from "./database-layout-icons"

export function DatabaseToolbarButton({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
          aria-label={label}
          title={label}
        >
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
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
  filterValues: Record<string, string>
  titleColumnName?: string
  sortValue: { key: string; direction: "asc" | "desc" } | null
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
  setFilterValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setSortValue: React.Dispatch<
    React.SetStateAction<{ key: string; direction: "asc" | "desc" } | null>
  >
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
  filterValues,
  titleColumnName,
  sortValue,
  openRowDialog,
  onToggleSearch,
  openRenameViewDialog,
  changeActiveViewLayout,
  setViewHiddenPropertyIds,
  togglePropertyVisibility,
  onOpenAddProperty,
  setFilterValues,
  setSortValue,
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

      {/* 5. Фильтр */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Filter className="size-4" />
          <span className="flex-1">{t("databaseWorkspace.filter")}</span>
          {Object.keys(filterValues).length > 0 && (
            <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {Object.keys(filterValues).length}
            </span>
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <DropdownMenuLabel>{t("databaseWorkspace.filter")}</DropdownMenuLabel>
          {Object.entries(filterValues).map(([key, value]) => {
            const property =
              key === "title"
                ? { name: titleColumnName ?? t("databaseTable.title") }
                : database?.properties.find((candidate) => candidate.propertyId === key)
            return (
              <DropdownMenuItem
                key={key}
                onSelect={() =>
                  setFilterValues((current) => {
                    const next = { ...current }
                    delete next[key]
                    return next
                  })
                }
              >
                <span className="min-w-0 flex-1 truncate">{property?.name ?? key}</span>
                <span className="max-w-24 truncate text-muted-foreground">{value}</span>
                <X className="ml-1 size-3 text-muted-foreground" />
              </DropdownMenuItem>
            )
          })}
          {Object.keys(filterValues).length === 0 ? (
            <DropdownMenuItem disabled>{t("databaseWorkspace.noFilters")}</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setFilterValues({})}>
              {t("databaseTable.clearFilter")}
            </DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      {/* 6. Сортировка */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <ArrowDownUp className="size-4" />
          <span className="flex-1">{t("databaseWorkspace.sort")}</span>
          {sortValue && <span className="ml-auto text-xs text-primary">✓</span>}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <DropdownMenuLabel>{t("databaseWorkspace.sort")}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setSortValue({ key: "title", direction: "asc" })}>
            {t("databaseWorkspace.sortAscending")}
            {sortValue?.key === "title" && sortValue.direction === "asc" && (
              <span className="ml-auto text-primary">✓</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSortValue({ key: "title", direction: "desc" })}>
            {t("databaseWorkspace.sortDescending")}
            {sortValue?.key === "title" && sortValue.direction === "desc" && (
              <span className="ml-auto text-primary">✓</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!sortValue} onSelect={() => setSortValue(null)}>
            {t("databaseTable.clearSort")}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

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

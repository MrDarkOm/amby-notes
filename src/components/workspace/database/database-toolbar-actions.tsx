import type { ViewSettings } from "./view-config"
import type { SettingsPatch } from "./view-config"
import type { ViewCondition } from "./view-config"
import type { DatabaseRowTemplate } from "@/lib/storage"
import { EMPTY_PROPERTIES } from "./empty-collections"
import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import {
  ArrowDownUp,
  ChevronDown,
  Database,
  FileText,
  Filter,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

import { cn } from "@/lib/utils"

import { ViewFilterEditor } from "./view-filter-editor"
import { ViewSortEditor } from "./view-sort-editor"
import { conditionsToFilter } from "./view-config"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { QueryPanelButton } from "./database-view-menu"

interface DatabaseToolbarActionsProps {
  queryPanel: "filter" | "sort" | null
  setQueryPanel: React.Dispatch<React.SetStateAction<"filter" | "sort" | null>>
  actionsRef: React.RefObject<HTMLDivElement | null>
  isCompactToolbar: boolean
  searchOpen: boolean
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  settingsOpen: boolean
  toggleSettings: () => void
  filterCount: number
  viewSettings: ViewSettings
  isDatabaseLocked: boolean
  vaultGeneration: number | null
  openRowDialog: (template: DatabaseRowTemplate) => void
  database: DatabaseSummary | undefined
  savedConditions: ViewCondition[] | null
  titleColumnName: string | undefined
  requestedFilterField: string | null
  setRequestedFilterField: React.Dispatch<React.SetStateAction<string | null>>
  updateViewSettings: (patch: SettingsPatch) => void
}

export function DatabaseToolbarActions({
  queryPanel,
  setQueryPanel,
  actionsRef,
  isCompactToolbar,
  searchOpen,
  setSearchOpen,
  settingsOpen,
  toggleSettings,
  filterCount,
  viewSettings,
  isDatabaseLocked,
  vaultGeneration,
  openRowDialog,
  database,
  savedConditions,
  titleColumnName,
  requestedFilterField,
  setRequestedFilterField,
  updateViewSettings,
}: DatabaseToolbarActionsProps) {
  const { t } = useTranslation()
  return (
    <Popover
      open={queryPanel !== null}
      onOpenChange={(open) => {
        if (!open) setQueryPanel(null)
      }}
    >
      <PopoverAnchor asChild>
        <div ref={actionsRef} className="ml-auto flex shrink-0 items-center gap-1">
          {isCompactToolbar ? (
            // Folded: search and settings as two icons; the rest is in the panel.
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
                title={t("databaseWorkspace.search")}
                aria-label={t("databaseWorkspace.search")}
                aria-pressed={searchOpen}
                onClick={() => setSearchOpen((open) => !open)}
              >
                {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "relative text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
                  settingsOpen && "bg-accent text-foreground",
                )}
                aria-label={t("databaseWorkspace.settings")}
                aria-pressed={settingsOpen}
                title={t("databaseWorkspace.settings")}
                onClick={toggleSettings}
              >
                <SlidersHorizontal className="size-4" />
                {(filterCount > 0 || viewSettings.sorts.length > 0) && (
                  <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </>
          ) : (
            <>
              <QueryPanelButton
                icon={<Filter className="size-4" />}
                label={t("databaseWorkspace.filter")}
                count={filterCount}
                active={queryPanel === "filter"}
                onClick={() => setQueryPanel((current) => (current === "filter" ? null : "filter"))}
              />
              <QueryPanelButton
                icon={<ArrowDownUp className="size-4" />}
                label={t("databaseWorkspace.sort")}
                count={viewSettings.sorts.length}
                active={queryPanel === "sort"}
                onClick={() => setQueryPanel((current) => (current === "sort" ? null : "sort"))}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
                title={t("databaseWorkspace.search")}
                aria-label={t("databaseWorkspace.search")}
                onClick={() => setSearchOpen((open) => !open)}
              >
                {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
                  settingsOpen && "bg-accent text-foreground",
                )}
                aria-label={t("databaseWorkspace.settings")}
                aria-pressed={settingsOpen}
                title={t("databaseWorkspace.settings")}
                onClick={toggleSettings}
              >
                <SlidersHorizontal className="size-4" />
              </Button>
              <div className="ml-2 inline-flex items-stretch">
                <Button
                  size="sm"
                  className="h-8 rounded-l-md rounded-r-none bg-primary px-3 text-xs text-primary-foreground shadow-sm hover:bg-primary/90"
                  disabled={isDatabaseLocked || vaultGeneration === null}
                  onClick={() => openRowDialog({ kind: "default" })}
                >
                  <Plus className="size-4" />
                  {t("databaseWorkspace.newPageButton")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      className="h-8 w-8 rounded-l-none rounded-r-md border-l border-primary-foreground/25 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                      disabled={isDatabaseLocked || vaultGeneration === null}
                      aria-label={t("databaseWorkspace.chooseTemplate")}
                      title={t("databaseWorkspace.chooseTemplate")}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>{t("databaseWorkspace.templates")}</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => openRowDialog({ kind: "default" })}>
                      <Database className="size-4" />
                      {t("databaseWorkspace.defaultTemplate")}
                    </DropdownMenuItem>
                    {database?.templates.map((template) => (
                      <DropdownMenuItem
                        key={template.templateId}
                        onSelect={() =>
                          openRowDialog({
                            kind: "template",
                            templateId: template.templateId,
                          })
                        }
                      >
                        <FileText className="size-4 shrink-0 text-primary" />
                        <span className="truncate">{template.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {(!database || database.templates.length === 0) && (
                      <DropdownMenuItem disabled>
                        {t("databaseWorkspace.noTemplates")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => openRowDialog({ kind: "empty" })}>
                      <Plus className="size-4" />
                      {t("databaseWorkspace.createTemplate")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-[28rem] max-w-[calc(100vw-2rem)] p-3"
        aria-label={queryPanel === "sort" ? t("databaseSort.title") : t("databaseFilter.title")}
      >
        {queryPanel === "filter" && (
          <ViewFilterEditor
            conditions={savedConditions ?? []}
            complex={savedConditions === null}
            properties={database?.properties ?? EMPTY_PROPERTIES}
            titleName={titleColumnName ?? t("databaseTable.title")}
            requestedField={requestedFilterField}
            onRequestedFieldHandled={() => setRequestedFilterField(null)}
            onChange={(conditions) =>
              updateViewSettings({ filter: conditionsToFilter(conditions) })
            }
            onResetComplex={() => updateViewSettings({ filter: null })}
          />
        )}
        {queryPanel === "sort" && (
          <ViewSortEditor
            sorts={viewSettings.sorts}
            properties={database?.properties ?? EMPTY_PROPERTIES}
            titleName={titleColumnName ?? t("databaseTable.title")}
            onChange={(sorts) => updateViewSettings({ sorts })}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

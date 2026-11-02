import type { ViewSettings } from "./view-config"
import type { SettingsPatch } from "./view-config"
import type { ViewCondition } from "./view-config"
import { EMPTY_PROPERTIES } from "./empty-collections"
import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"
import { createPortal } from "react-dom"
import { SlidersHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

import { cn } from "@/lib/utils"

import { ViewFilterEditor } from "./view-filter-editor"
import { ViewSortEditor } from "./view-sort-editor"
import { conditionsToFilter } from "./view-config"

interface DatabaseSettingsToggleProps {
  toolbarHost: HTMLElement | null
  queryPanel: "filter" | "sort" | null
  setQueryPanel: React.Dispatch<React.SetStateAction<"filter" | "sort" | null>>
  actionsRef: React.RefObject<HTMLDivElement | null>
  settingsOpen: boolean
  toggleSettings: () => void
  filterCount: number
  viewSettings: ViewSettings
  savedConditions: ViewCondition[] | null
  database: DatabaseSummary | undefined
  titleColumnName: string | undefined
  requestedFilterField: string | null
  setRequestedFilterField: React.Dispatch<React.SetStateAction<string | null>>
  updateViewSettings: (patch: SettingsPatch) => void
}

export function DatabaseSettingsToggle({
  toolbarHost,
  queryPanel,
  setQueryPanel,
  actionsRef,
  settingsOpen,
  toggleSettings,
  filterCount,
  viewSettings,
  savedConditions,
  database,
  titleColumnName,
  requestedFilterField,
  setRequestedFilterField,
  updateViewSettings,
}: DatabaseSettingsToggleProps) {
  const { t } = useTranslation()
  return (
    toolbarHost &&
    createPortal(
      <Popover
        open={queryPanel !== null}
        onOpenChange={(open) => {
          if (!open) setQueryPanel(null)
        }}
      >
        <PopoverAnchor asChild>
          <div ref={actionsRef} className="flex shrink-0 items-center">
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
      </Popover>,
      toolbarHost,
    )
  )
}

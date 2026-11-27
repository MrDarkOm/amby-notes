import type { ViewSettings } from "./view-config"
import type { SettingsPatch } from "./view-config"
import type { DatabaseRowTemplate } from "@/lib/storage"
import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import * as React from "react"

import { AnimatePresence } from "motion/react"

import { type DatabaseFieldRef, type DatabasePropertySummary } from "@/lib/storage"

import { ViewSettingsPanel } from "./view-settings-panel"

import { databasePropertyIconKey, databaseViewIconKey } from "./property-icon"

interface DatabaseSettingsOverlayProps {
  settingsOpen: boolean
  settingsPanelTop: number
  settingsFocusSignal: number
  hideHeader: boolean
  isCompactToolbar: boolean
  isDatabaseLocked: boolean
  vaultGeneration: number | null
  activeView: DatabaseViewSummary | undefined
  database: DatabaseSummary | undefined
  mutationBusy: boolean
  searchOpen: boolean
  isLinkCopied: boolean
  activeHiddenPropertyIds: Set<string>
  filterCount: number
  viewSettings: ViewSettings
  setQueryPanel: React.Dispatch<React.SetStateAction<"sort" | "filter" | null>>
  openRowDialog: (template: DatabaseRowTemplate) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  iconOverrides: Record<string, string>
  databaseId: string
  setIcon: (id: string, icon: string) => void
  renameActiveView: (name: string) => Promise<void>
  renderPropertySettings: (property: DatabasePropertySummary) => React.JSX.Element | null
  persistPropertyName: (propertyId: string, nextName: string) => Promise<void>
  persistPropertyType: (
    propertyId: string,
    nextPropertyType: string,
    nextRelationTargetDatabaseId?: string,
  ) => Promise<void>
  deleteProperty: (propertyId: string) => Promise<void>
  changeActiveViewLayout: (
    newLayout: "table" | "board" | "list" | "gallery" | "chart",
  ) => Promise<void>
  updateViewSettings: (patch: SettingsPatch) => void
  groupField: DatabaseFieldRef | null
  setViewHiddenPropertyIds: (
    targetViewId: string,
    ids: Set<string> | string[] | ((current: Set<string>) => Set<string>),
  ) => void
  togglePropertyVisibility: (propertyId: string) => void
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  setPropertyInsertBeforeId: React.Dispatch<React.SetStateAction<string | undefined>>
  setRelationTargetDatabaseId: React.Dispatch<React.SetStateAction<string>>
  setPropertyDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  copyLinkToView: () => Promise<void>
  handleToggleLock: () => void
  mutateView: (action: "duplicate" | "delete" | "default", targetViewId: string) => Promise<void>
}

export function DatabaseSettingsOverlay({
  settingsOpen,
  settingsPanelTop,
  settingsFocusSignal,
  hideHeader,
  isCompactToolbar,
  isDatabaseLocked,
  vaultGeneration,
  activeView,
  database,
  mutationBusy,
  searchOpen,
  isLinkCopied,
  activeHiddenPropertyIds,
  filterCount,
  viewSettings,
  setQueryPanel,
  openRowDialog,
  setSearchOpen,
  setSettingsOpen,
  setSearchQuery,
  iconOverrides,
  databaseId,
  setIcon,
  renameActiveView,
  renderPropertySettings,
  persistPropertyName,
  persistPropertyType,
  deleteProperty,
  changeActiveViewLayout,
  updateViewSettings,
  groupField,
  setViewHiddenPropertyIds,
  togglePropertyVisibility,
  setMutationError,
  setPropertyInsertBeforeId,
  setRelationTargetDatabaseId,
  setPropertyDialogOpen,
  copyLinkToView,
  handleToggleLock,
  mutateView,
}: DatabaseSettingsOverlayProps) {
  return (
    <AnimatePresence>
      {settingsOpen && (
        <ViewSettingsPanel
          key="view-settings"
          top={settingsPanelTop}
          focusNameSignal={settingsFocusSignal}
          isCompactToolbar={hideHeader || isCompactToolbar}
          isDatabaseLocked={isDatabaseLocked}
          vaultGeneration={vaultGeneration}
          activeView={activeView}
          database={database}
          mutationBusy={mutationBusy}
          searchOpen={searchOpen}
          isLinkCopied={isLinkCopied}
          activeHiddenPropertyIds={activeHiddenPropertyIds}
          filterCount={filterCount}
          sortCount={viewSettings.sorts.length}
          onOpenFilter={() => setQueryPanel("filter")}
          onOpenSort={() => setQueryPanel("sort")}
          openRowDialog={openRowDialog}
          onToggleSearch={
            hideHeader
              ? () => {
                  setSearchOpen((open) => {
                    const next = !open
                    if (next) setSettingsOpen(false)
                    else setSearchQuery("")
                    return next
                  })
                }
              : undefined
          }
          viewIcon={
            activeView
              ? iconOverrides[databaseViewIconKey(databaseId, activeView.viewId)]
              : undefined
          }
          onViewIconChange={(icon) =>
            activeView && setIcon(databaseViewIconKey(databaseId, activeView.viewId), icon)
          }
          onRenameView={renameActiveView}
          renderPropertySettings={renderPropertySettings}
          propertyIconOf={(propertyId) =>
            iconOverrides[databasePropertyIconKey(databaseId, propertyId)]
          }
          onPropertyIconChange={(propertyId, icon) =>
            setIcon(databasePropertyIconKey(databaseId, propertyId), icon)
          }
          onRenameProperty={persistPropertyName}
          onChangePropertyType={(propertyId, propertyType) =>
            persistPropertyType(propertyId, propertyType)
          }
          onDeleteProperty={deleteProperty}
          changeActiveViewLayout={changeActiveViewLayout}
          cardSize={viewSettings.cardSize}
          openMode={viewSettings.openMode}
          onOpenModeChange={(openMode) => updateViewSettings({ openMode })}
          onCardSizeChange={(cardSize) => updateViewSettings({ cardSize })}
          groupPropertyId={groupField?.kind === "property" ? groupField.propertyId : null}
          onGroupPropertyChange={(groupBy) => updateViewSettings({ groupBy })}
          coverVisible={viewSettings.coverVisible}
          onCoverVisibleChange={(coverVisible) => updateViewSettings({ coverVisible })}
          colorColumns={viewSettings.colorColumns}
          onColorColumnsChange={(colorColumns) => updateViewSettings({ colorColumns })}
          groupSort={viewSettings.groupSort}
          onGroupSortChange={(groupSort) => updateViewSettings({ groupSort })}
          hideEmptyGroups={viewSettings.hideEmptyGroups}
          onHideEmptyGroupsChange={(hideEmptyGroups) => updateViewSettings({ hideEmptyGroups })}
          groupOrder={viewSettings.groupOrder}
          onGroupOrderChange={(groupOrder) =>
            updateViewSettings({ groupOrder, groupSort: "manual" })
          }
          hiddenGroups={viewSettings.hiddenGroups}
          onHiddenGroupsChange={(hiddenGroups) => updateViewSettings({ hiddenGroups })}
          setViewHiddenPropertyIds={setViewHiddenPropertyIds}
          togglePropertyVisibility={togglePropertyVisibility}
          onOpenAddProperty={() => {
            setMutationError(null)
            setPropertyInsertBeforeId(undefined)
            setRelationTargetDatabaseId(databaseId)
            setPropertyDialogOpen(true)
          }}
          copyLinkToView={copyLinkToView}
          handleToggleLock={handleToggleLock}
          mutateView={mutateView}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </AnimatePresence>
  )
}

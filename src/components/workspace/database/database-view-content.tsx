import type { ViewSettings } from "./view-config"
import type { SettingsPatch } from "./view-config"
import type { GroupSort } from "./view-config"
import type { DatabaseHostSession } from "./database-store"
import type { RowMenuModel } from "./row-menu"
import type { RowReorderConfig } from "./table-view"
import type { PropertyMutationRow } from "./use-property-mutation"
import type { DatabaseRowTemplate } from "@/lib/storage"
import type { DatabaseFilterNode } from "@/lib/storage"
import type { DatabaseSortSpec } from "@/lib/storage"
import type { DatabaseYamlSyncResult } from "@/lib/storage"
import type { DatabaseYamlConflict } from "@/lib/storage"
import type { DatabaseYamlResolution } from "@/lib/storage"
import { EMPTY_PROPERTIES } from "./empty-collections"
import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import * as React from "react"

import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"

import { motionTransition, motionTransitions } from "@/lib/motion-config"

import { cn } from "@/lib/utils"
import {
  type DatabaseFieldRef,
  type DatabaseRow,
  type DatabasePropertySummary,
} from "@/lib/storage"

import { TableView } from "./table-view"
import { DatabaseSidePeek } from "./peek/database-side-peek"
import { BoardView, GalleryView, ListView } from "./layouts"

import { BoardLanesView } from "./board-lanes-view"
import { GalleryLanesView } from "./gallery-lanes-view"

import type { CardCellEdit } from "./database-value-cell"

import { PeekProperties } from "./peek/peek-properties"

import { BoardGroupPrompt } from "./board-group-prompt"

import { isOptionProperty } from "./option-model"

import { ChartView } from "./chart-view"

import type { Document } from "../use-doc-store"

import { PeekRowEditor } from "./database-peek-editor"

interface DatabaseViewContentProps {
  contentAreaRef: React.RefObject<HTMLDivElement | null>
  viewId: string | null
  selectedView: DatabaseViewSummary | undefined
  databaseId: string
  vaultGeneration: number | null
  queriesEnabled: boolean
  chartCategory: { kind: "property"; propertyId: string } | undefined
  queryFilter: DatabaseFilterNode | undefined
  searchQuery: string
  displayRows: DatabaseRow[]
  cardFieldIds: string[] | null
  cardEdit: CardCellEdit | undefined
  database: DatabaseSummary | undefined
  relationTitles: Record<string, string>
  activeHost: DatabaseHostSession
  loadNextPage: () => Promise<void>
  retry: () => Promise<void>
  openRow: (row: DatabaseRow) => void
  rowMenu: (row: DatabaseRow) => RowMenuModel
  rowReorder: RowReorderConfig
  isDatabaseLocked: boolean
  openRowDialog: (template: DatabaseRowTemplate) => void
  boardGroupProperty: DatabasePropertySummary | null
  viewSettings: ViewSettings
  querySorts: DatabaseSortSpec[]
  boardEnabled: boolean
  groupDisplay: { sort: GroupSort; order: string[]; hidden: string[]; hideEmpty: boolean }
  openRowDialogInLane: (laneKey: string) => void
  moveRowToGroup: (row: DatabaseRow, laneKey: string) => Promise<void>
  groupField: DatabaseFieldRef | null
  updateViewSettings: (patch: SettingsPatch) => void
  databases: DatabaseSummary[]
  handleOpenNote: (noteId: string) => void
  handleCreateRelationRow: (
    targetDatabaseId: string,
    rowTitleText: string,
  ) => Promise<string | void>
  titleColumnName: string | undefined
  onTitleColumnNameChange: ((name: string) => void) | undefined
  onRenameProperty: ((propertyId: string, name: string) => Promise<void> | void) | undefined
  persistPropertyName: (propertyId: string, nextName: string) => Promise<void>
  persistPropertyType: (
    propertyId: string,
    nextPropertyType: string,
    nextRelationTargetDatabaseId?: string,
  ) => Promise<void>
  computedErrors: { formula?: string; rollup?: string }
  renderPropertySettings: (property: DatabasePropertySummary) => React.JSX.Element | null
  onRenameRow: ((rowId: string, name: string) => Promise<void> | void) | undefined
  filteredFieldKeys: Set<string>
  setRequestedFilterField: React.Dispatch<React.SetStateAction<string | null>>
  setQueryPanel: React.Dispatch<React.SetStateAction<"sort" | "filter" | null>>
  sortValue: { key: string; direction: "asc" | "desc" } | null
  setSortValue: React.Dispatch<
    React.SetStateAction<{ key: string; direction: "asc" | "desc" } | null>
  >
  pendingCells: Set<string>
  cellErrors: Record<string, string>
  commitCell: (
    row: PropertyMutationRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  deleteProperty: (propertyId: string) => Promise<void>
  deleteRows: ((noteIds: string[]) => Promise<void>) | undefined
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  setPropertyInsertBeforeId: React.Dispatch<React.SetStateAction<string | undefined>>
  setRelationTargetDatabaseId: React.Dispatch<React.SetStateAction<string>>
  setPropertyDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  tableSavedSettings: {
    widths: Record<string, number>
    wrapped: string[]
    frozenKey: string | null
  }
  activeHiddenPropertyIds: Set<string>
  activeView: DatabaseViewSummary | undefined
  setViewHiddenPropertyIds: (
    targetViewId: string,
    ids: Set<string> | string[] | ((current: Set<string>) => Set<string>),
  ) => void
  selectedRow: DatabaseRow | null
  commitPeekCell: (
    row: DatabaseRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  selectedRowIndex: number
  selectAdjacentRow: (offset: number) => void
  yamlSyncState: {
    rowId: string
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
  } | null
  syncYamlForRow: (row: DatabaseRow) => Promise<void>
  resolveYamlForRow: (
    row: DatabaseRow,
    conflict: DatabaseYamlConflict,
    resolution: DatabaseYamlResolution,
    manualValueJson?: string,
  ) => Promise<void>
  setSelectedRowId: React.Dispatch<React.SetStateAction<string | null>>
  onOpenRowFullPage: ((row: DatabaseRow) => void) | undefined
  onLoadRowDocument: ((row: DatabaseRow) => Promise<Document>) | undefined
  vault: string | undefined
  onRowContentChange: ((fileId: string, content: string) => void) | undefined
}

export function DatabaseViewContent({
  contentAreaRef,
  viewId,
  selectedView,
  databaseId,
  vaultGeneration,
  queriesEnabled,
  chartCategory,
  queryFilter,
  searchQuery,
  displayRows,
  cardFieldIds,
  cardEdit,
  database,
  relationTitles,
  activeHost,
  loadNextPage,
  retry,
  openRow,
  rowMenu,
  rowReorder,
  isDatabaseLocked,
  openRowDialog,
  boardGroupProperty,
  viewSettings,
  querySorts,
  boardEnabled,
  groupDisplay,
  openRowDialogInLane,
  moveRowToGroup,
  groupField,
  updateViewSettings,
  databases,
  handleOpenNote,
  handleCreateRelationRow,
  titleColumnName,
  onTitleColumnNameChange,
  onRenameProperty,
  persistPropertyName,
  persistPropertyType,
  computedErrors,
  renderPropertySettings,
  onRenameRow,
  filteredFieldKeys,
  setRequestedFilterField,
  setQueryPanel,
  sortValue,
  setSortValue,
  pendingCells,
  cellErrors,
  commitCell,
  deleteProperty,
  deleteRows,
  setMutationError,
  setPropertyInsertBeforeId,
  setRelationTargetDatabaseId,
  setPropertyDialogOpen,
  tableSavedSettings,
  activeHiddenPropertyIds,
  activeView,
  setViewHiddenPropertyIds,
  selectedRow,
  commitPeekCell,
  selectedRowIndex,
  selectAdjacentRow,
  yamlSyncState,
  syncYamlForRow,
  resolveYamlForRow,
  setSelectedRowId,
  onOpenRowFullPage,
  onLoadRowDocument,
  vault,
  onRowContentChange,
}: DatabaseViewContentProps) {
  const { t } = useTranslation()
  return (
    <div ref={contentAreaRef} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 gap-4 px-0 pb-6 pt-2">
        <motion.div
          // A new view (or layout) fades and rises in instead of snapping.
          key={`${viewId ?? "none"}:${selectedView?.layout ?? "table"}`}
          className={cn(
            "flex min-w-0 flex-1 rounded-xl bg-[var(--note-surface)]",
            // The grips of a table or list hang outside this surface.
            selectedView &&
              selectedView.layout !== "list" &&
              selectedView.layout !== "table" &&
              "overflow-hidden",
          )}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionTransition(motionTransitions.enter)}
        >
          {selectedView?.layout === "chart" && viewId ? (
            <ChartView
              databaseId={databaseId}
              expectedGeneration={vaultGeneration}
              enabled={queriesEnabled}
              category={chartCategory}
              filter={queryFilter}
              search={searchQuery}
            />
          ) : selectedView?.layout === "list" ? (
            <ListView
              rows={displayRows}
              cardFields={cardFieldIds}
              cardEdit={cardEdit}
              properties={database?.properties ?? EMPTY_PROPERTIES}
              relationTitles={relationTitles}
              loading={activeHost?.status === "loading"}
              error={activeHost?.error}
              hasNextPage={Boolean(activeHost?.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={openRow}
              rowMenu={rowMenu}
              rowReorder={rowReorder}
              onCreateCard={
                onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                  ? () => openRowDialog({ kind: "empty" })
                  : undefined
              }
            />
          ) : selectedView?.layout === "gallery" && boardGroupProperty ? (
            <GalleryLanesView
              databaseId={databaseId}
              groupProperty={boardGroupProperty}
              properties={database?.properties ?? EMPTY_PROPERTIES}
              relationTitles={relationTitles}
              cardFields={cardFieldIds}
              cardEdit={cardEdit}
              cardSize={viewSettings.cardSize}
              coverVisible={viewSettings.coverVisible}
              vaultGeneration={vaultGeneration}
              filter={queryFilter}
              sorts={querySorts}
              search={searchQuery}
              enabled={boardEnabled}
              onRowSelect={openRow}
              rowMenu={rowMenu}
              colorColumns={viewSettings.colorColumns}
              groupDisplay={groupDisplay}
              onCreateCard={
                onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                  ? openRowDialogInLane
                  : undefined
              }
            />
          ) : selectedView?.layout === "gallery" ? (
            <GalleryView
              rows={displayRows}
              cardFields={cardFieldIds}
              cardEdit={cardEdit}
              cardSize={viewSettings.cardSize}
              coverVisible={viewSettings.coverVisible}
              databaseId={databaseId}
              vaultGeneration={vaultGeneration}
              properties={database?.properties ?? EMPTY_PROPERTIES}
              relationTitles={relationTitles}
              loading={activeHost?.status === "loading"}
              error={activeHost?.error}
              hasNextPage={Boolean(activeHost?.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={openRow}
              rowMenu={rowMenu}
              rowReorder={rowReorder}
              onCreateCard={
                onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                  ? () => openRowDialog({ kind: "empty" })
                  : undefined
              }
            />
          ) : selectedView?.layout === "board" ? (
            boardGroupProperty ? (
              <BoardLanesView
                databaseId={databaseId}
                groupProperty={boardGroupProperty}
                properties={database?.properties ?? EMPTY_PROPERTIES}
                relationTitles={relationTitles}
                cardFields={cardFieldIds}
                cardEdit={cardEdit}
                filter={queryFilter}
                sorts={querySorts}
                search={searchQuery}
                enabled={boardEnabled}
                onRowSelect={openRow}
                onMoveRow={moveRowToGroup}
                colorColumns={viewSettings.colorColumns}
                groupDisplay={groupDisplay}
                onCreateCard={
                  onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                    ? openRowDialogInLane
                    : undefined
                }
              />
            ) : (
              <>
                {!groupField && (
                  <BoardGroupPrompt
                    candidates={(database?.properties ?? EMPTY_PROPERTIES).filter(
                      (property) =>
                        isOptionProperty(property.propertyType) &&
                        property.propertyType !== "multiSelect",
                    )}
                    disabled={isDatabaseLocked}
                    onPick={(groupBy) => updateViewSettings({ groupBy })}
                  />
                )}
                <BoardView
                  rows={displayRows}
                  cardFields={cardFieldIds}
                  cardEdit={cardEdit}
                  properties={database?.properties ?? EMPTY_PROPERTIES}
                  relationTitles={relationTitles}
                  groupField={groupField}
                  loading={activeHost?.status === "loading"}
                  error={activeHost?.error}
                  hasNextPage={Boolean(activeHost?.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={openRow}
                  onMoveRow={moveRowToGroup}
                  onCreateCard={
                    onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                      ? () => openRowDialog({ kind: "empty" })
                      : undefined
                  }
                />
              </>
            )
          ) : (
            <TableView
              databaseId={databaseId}
              rows={displayRows}
              properties={database?.properties ?? EMPTY_PROPERTIES}
              databases={databases}
              onOpenNote={handleOpenNote}
              onCreateRelationRow={handleCreateRelationRow}
              titleColumnName={titleColumnName ?? t("databaseTable.title")}
              onTitleColumnNameChange={onTitleColumnNameChange}
              onRenameProperty={
                onRenameProperty ??
                (!isDatabaseLocked && vaultGeneration !== null ? persistPropertyName : undefined)
              }
              onChangePropertyType={
                isDatabaseLocked || vaultGeneration === null ? undefined : persistPropertyType
              }
              computedErrors={computedErrors}
              renderPropertySettings={renderPropertySettings}
              onRenameRow={onRenameRow}
              filteredFieldKeys={filteredFieldKeys}
              onFilterColumn={(key) => {
                setRequestedFilterField(key)
                setQueryPanel("filter")
              }}
              sortValue={sortValue}
              onSortValueChange={setSortValue}
              pendingCells={pendingCells}
              cellErrors={cellErrors}
              onCellCommit={commitCell}
              onDeleteProperty={
                isDatabaseLocked || vaultGeneration === null ? undefined : deleteProperty
              }
              loading={activeHost?.status === "loading"}
              error={activeHost?.error}
              hasNextPage={Boolean(activeHost?.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={openRow}
              rowMenu={rowMenu}
              rowReorder={rowReorder}
              onDeleteRows={deleteRows}
              onAddProperty={
                isDatabaseLocked
                  ? undefined
                  : (beforePropertyId) => {
                      setMutationError(null)
                      setPropertyInsertBeforeId(beforePropertyId)
                      setRelationTargetDatabaseId(databaseId)
                      setPropertyDialogOpen(true)
                    }
              }
              onCreateRow={
                onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                  ? () => openRowDialog({ kind: "empty" })
                  : undefined
              }
              newPageLabel={t("databaseWorkspace.newPage")}
              savedSettings={tableSavedSettings}
              onSavedSettingsChange={updateViewSettings}
              hiddenPropertyIds={activeHiddenPropertyIds}
              onHiddenPropertyIdsChange={(next) => {
                if (activeView) {
                  setViewHiddenPropertyIds(activeView.viewId, next)
                }
              }}
            />
          )}
        </motion.div>
        <AnimatePresence>
          {selectedRow && (
            <DatabaseSidePeek
              key="row-peek"
              row={selectedRow}
              variant={viewSettings.openMode === "centerPeek" ? "center" : "side"}
              propertiesSection={
                <PeekProperties
                  row={selectedRow}
                  properties={database?.properties ?? EMPTY_PROPERTIES}
                  databases={databases}
                  currentDatabaseId={databaseId}
                  pendingCells={pendingCells}
                  cellErrors={cellErrors}
                  disabled={isDatabaseLocked}
                  onCommit={commitPeekCell}
                  onOpenNote={handleOpenNote}
                  onCreateRelationRow={handleCreateRelationRow}
                />
              }
              canPrevious={selectedRowIndex > 0}
              canNext={selectedRowIndex < displayRows.length - 1}
              onPrevious={() => selectAdjacentRow(-1)}
              onNext={() => selectAdjacentRow(1)}
              yamlSync={
                yamlSyncState?.rowId === selectedRow.noteId
                  ? {
                      busy: yamlSyncState.busy,
                      error: yamlSyncState.error,
                      result: yamlSyncState.result,
                      onSync: () => void syncYamlForRow(selectedRow),
                      onResolve: (conflict, resolution, manualValueJson) =>
                        void resolveYamlForRow(selectedRow, conflict, resolution, manualValueJson),
                    }
                  : {
                      busy: false,
                      error: null,
                      result: null,
                      onSync: () => void syncYamlForRow(selectedRow),
                      onResolve: (conflict, resolution, manualValueJson) =>
                        void resolveYamlForRow(selectedRow, conflict, resolution, manualValueJson),
                    }
              }
              onClose={() => setSelectedRowId(null)}
              onOpenFullPage={() => onOpenRowFullPage?.(selectedRow)}
              body={
                onLoadRowDocument ? (
                  <PeekRowEditor
                    row={selectedRow}
                    vault={vault}
                    onLoad={onLoadRowDocument}
                    onContentChange={onRowContentChange}
                  />
                ) : undefined
              }
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function onCreateRowAvailable(locked: boolean | undefined, generation: number | null) {
  return !locked && generation !== null
}

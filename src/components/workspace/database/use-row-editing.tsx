import type { RenameOutcome } from "../file-actions/rename-outcome"
import type { ViewSettings } from "./view-config"
import type { SettingsPatch } from "./view-config"
import type { PropertyMutationRow } from "./use-property-mutation"
import type { DatabaseSummary } from "@/lib/storage"
import { EMPTY_PROPERTIES } from "./empty-collections"

import * as React from "react"

import { type DatabaseRow, type DatabasePropertySummary } from "@/lib/storage"

import type { CardCellEdit } from "./database-value-cell"
import { applyCellValue } from "./database-cell-value"
import { PeekProperties } from "./peek/peek-properties"

import {
  useDeleteRows,
  useRowMenu,
  useRowReorderConfig,
  type DatabaseRowActions,
} from "./use-row-menu"

interface UseRowEditingParams {
  isDatabaseLocked: boolean
  commitCell: (
    row: PropertyMutationRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  pendingCells: Set<string>
  cellErrors: Record<string, string>
  handleOpenNote: (noteId: string) => void
  onRenameRow: ((rowId: string, name: string) => Promise<RenameOutcome | void> | void) | undefined
  retry: () => Promise<void>
  setSelectedRowSnapshot: React.Dispatch<React.SetStateAction<DatabaseRow | null>>
  database: DatabaseSummary | undefined
  databases: DatabaseSummary[]
  databaseId: string
  handleCreateRelationRow: (
    targetDatabaseId: string,
    rowTitleText: string,
  ) => Promise<string | void>
  viewSettings: ViewSettings
  vaultGeneration: number | null
  rowActions: DatabaseRowActions | undefined
  openRow: (row: DatabaseRow) => void
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  displayRows: DatabaseRow[]
  updateViewSettings: (patch: SettingsPatch) => void
}

export function useRowEditing({
  isDatabaseLocked,
  commitCell,
  pendingCells,
  cellErrors,
  handleOpenNote,
  onRenameRow,
  retry,
  setSelectedRowSnapshot,
  database,
  databases,
  databaseId,
  handleCreateRelationRow,
  viewSettings,
  vaultGeneration,
  rowActions,
  openRow,
  setMutationError,
  displayRows,
  updateViewSettings,
}: UseRowEditingParams) {
  const cardEdit = React.useMemo<CardCellEdit | undefined>(
    () =>
      isDatabaseLocked
        ? undefined
        : {
            onCommit: commitCell,
            pendingCells,
            cellErrors,
            onOpenNote: handleOpenNote,
            onRename: onRenameRow
              ? async (row, name) => {
                  await onRenameRow(row.noteId, name)
                  retry()
                }
              : undefined,
          },
    [cellErrors, commitCell, handleOpenNote, isDatabaseLocked, onRenameRow, pendingCells, retry],
  )
  const commitPeekCell = React.useCallback(
    async (row: DatabaseRow, property: DatabasePropertySummary, valueJson?: string) => {
      await commitCell(row, property, valueJson)
      // A card opened from a board lane may not be in the loaded page: keep its copy current.
      setSelectedRowSnapshot((current) =>
        current?.noteId === row.noteId
          ? {
              ...current,
              valuesJson: applyCellValue(current.valuesJson, property.propertyId, valueJson),
            }
          : current,
      )
    },
    [commitCell, setSelectedRowSnapshot],
  )

  // The grip of a row: drag to place it by hand (while no sort decides the order), press for its menu.
  const renderRowProperties = React.useCallback(
    (row: DatabaseRow) => (
      <PeekProperties
        row={row}
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
    ),
    [
      cellErrors,
      commitPeekCell,
      database?.properties,
      databaseId,
      databases,
      handleCreateRelationRow,
      handleOpenNote,
      isDatabaseLocked,
      pendingCells,
    ],
  )
  const rowMenu = useRowMenu({
    databaseId,
    databases,
    openMode: viewSettings.openMode,
    locked: isDatabaseLocked,
    vaultGeneration,
    actions: rowActions,
    openRow,
    onRenameRow,
    refresh: retry,
    onError: setMutationError,
    renderProperties: renderRowProperties,
  })
  const deleteRows = useDeleteRows({
    actions: rowActions,
    locked: isDatabaseLocked,
    refresh: retry,
  })
  const [sortPromptOpen, setSortPromptOpen] = React.useState(false)
  const sorted = viewSettings.sorts.length > 0
  const rowReorder = useRowReorderConfig({
    rows: displayRows,
    manualOrder: viewSettings.manualOrder,
    enabled: !isDatabaseLocked && !sorted,
    onChange: (manualOrder) => updateViewSettings({ manualOrder }),
    // Dragging while a sort decides the order offers to drop the sort for a custom order.
    onBlockedDrag: !isDatabaseLocked && sorted ? () => setSortPromptOpen(true) : undefined,
  })

  return {
    cardEdit,
    rowMenu,
    rowReorder,
    deleteRows,
    commitPeekCell,
    sortPromptOpen,
    setSortPromptOpen,
  }
}

import type { ViewSettings } from "./view-config"
import * as React from "react"

import { type DatabaseRow } from "@/lib/storage"

interface UseSelectedRowParams {
  viewSettings: ViewSettings
  onOpenRowFullPage: ((row: DatabaseRow) => void) | undefined
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  displayRows: DatabaseRow[]
}

export function useSelectedRow({
  viewSettings,
  onOpenRowFullPage,
  setSettingsOpen,
  displayRows,
}: UseSelectedRowParams) {
  const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null)
  // A card opened from a board lane may not be in the loaded table page.
  const [selectedRowSnapshot, setSelectedRowSnapshot] = React.useState<DatabaseRow | null>(null)

  const openRow = React.useCallback(
    (row: DatabaseRow) => {
      if (viewSettings.openMode === "fullPage" && onOpenRowFullPage) {
        onOpenRowFullPage(row)
        return
      }
      // The record takes the room of the settings panel.
      setSettingsOpen(false)
      setSelectedRowSnapshot(row)
      setSelectedRowId(row.noteId)
    },
    [onOpenRowFullPage, viewSettings.openMode, setSettingsOpen],
  )

  const selectedRow =
    displayRows.find((row) => row.noteId === selectedRowId) ??
    (selectedRowSnapshot?.noteId === selectedRowId ? selectedRowSnapshot : null)
  const selectedRowIndex = selectedRow ? displayRows.indexOf(selectedRow) : -1
  const selectAdjacentRow = (offset: number) => {
    if (selectedRowIndex < 0) return
    const next = displayRows[selectedRowIndex + offset]
    if (next) setSelectedRowId(next.noteId)
  }

  return {
    setSelectedRowId,
    setSelectedRowSnapshot,
    openRow,
    selectedRow,
    selectedRowIndex,
    selectAdjacentRow,
  }
}

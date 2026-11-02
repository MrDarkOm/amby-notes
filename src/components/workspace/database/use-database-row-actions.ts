import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { useTranslation } from "react-i18next"

import { logger } from "@/lib/logger"

import {
  applyDatabaseValueBatch,
  createDatabaseRow,
  resolveDatabaseYamlConflict,
  syncDatabaseYaml,
  type DatabaseYamlConflict,
  type DatabaseYamlResolution,
  type DatabaseFieldRef,
  type DatabaseRow,
  type DatabaseRowTemplate,
  type CreatedDatabaseRow,
  type DatabaseYamlSyncResult,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

import { placeNewRecordInLane } from "./new-record-lane"

import { createRelationTargetRow } from "./use-property-mutation"

interface UseDatabaseRowActionsParams {
  databaseId: string
  vaultGeneration: number | null
  database: DatabaseSummary | undefined
  groupField: DatabaseFieldRef | null
  mutationBusy: boolean
  setMutationBusy: React.Dispatch<React.SetStateAction<boolean>>
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  setSelectedRowId: React.Dispatch<React.SetStateAction<string | null>>
  onRowCreated: ((row: CreatedDatabaseRow) => Promise<void>) | undefined
  onCatalogChanged: (() => Promise<void>) | undefined
  retry: () => Promise<void>
  refreshHistoryStatus: () => Promise<void>
}

export function useDatabaseRowActions({
  databaseId,
  vaultGeneration,
  database,
  groupField,
  mutationBusy,
  setMutationBusy,
  setMutationError,
  setSelectedRowId,
  onRowCreated,
  onCatalogChanged,
  retry,
  refreshHistoryStatus,
}: UseDatabaseRowActionsParams) {
  const { t } = useTranslation()
  const [rowDialogOpen, setRowDialogOpen] = React.useState(false)
  const [rowTitle, setRowTitle] = React.useState("")
  const [rowTemplate, setRowTemplate] = React.useState<DatabaseRowTemplate>({ kind: "empty" })
  // Set when the page is added from a board lane: it is created in that lane.
  const [rowLaneKey, setRowLaneKey] = React.useState<string | null>(null)

  const [yamlSyncState, setYamlSyncState] = React.useState<{
    rowId: string
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
  } | null>(null)

  const openRowDialog = React.useCallback(
    (template: DatabaseRowTemplate) => {
      setRowTemplate(template)
      setRowLaneKey(null)
      setRowTitle("")
      setMutationError(null)
      setRowDialogOpen(true)
    },
    [setMutationError],
  )

  const openRowDialogInLane = React.useCallback(
    (laneKey: string) => {
      openRowDialog({ kind: "empty" })
      setRowLaneKey(laneKey)
    },
    [openRowDialog],
  )

  const createRow = React.useCallback(async () => {
    if (vaultGeneration === null || !rowTitle.trim() || mutationBusy) return
    setMutationBusy(true)
    setMutationError(null)
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId,
        title: rowTitle.trim(),
        template: rowTemplate,
      })
      logger.info("database.create_row", {
        databaseId,
        noteId: created.noteId,
        title: rowTitle.trim(),
        template: rowTemplate.kind,
      })
      // A page added from a board lane belongs to that lane.
      if (rowLaneKey && groupField?.kind === "property") {
        const groupProperty = database?.properties.find(
          (candidate) => candidate.propertyId === groupField.propertyId,
        )
        if (groupProperty) {
          await placeNewRecordInLane({
            vaultGeneration,
            databaseId,
            created,
            groupProperty,
            laneKey: rowLaneKey,
          })
        }
      }
      setSelectedRowId(created.noteId)
      setRowTitle("")
      setRowDialogOpen(false)
      const refreshResults = await Promise.allSettled([onRowCreated?.(created), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      const notices = [...created.warnings]
      if (refreshFailure) {
        notices.push(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    } catch (error) {
      logger.error("database.create_row_failed", { databaseId, title: rowTitle.trim(), error })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    database?.properties,
    databaseId,
    groupField,
    mutationBusy,
    onRowCreated,
    retry,
    rowLaneKey,
    rowTemplate,
    rowTitle,
    vaultGeneration,
    setMutationBusy,
    setMutationError,
    setSelectedRowId,
  ])

  const handleCreateRelationRow = React.useCallback(
    async (targetDatabaseId: string, rowTitleText: string): Promise<string | void> => {
      if (vaultGeneration === null || !rowTitleText.trim() || mutationBusy) return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const createdNoteId = await createRelationTargetRow(
          vaultGeneration,
          targetDatabaseId,
          rowTitleText,
        )
        await Promise.allSettled([onCatalogChanged?.(), retry()])
        return createdNoteId
      } catch (error) {
        logger.error("database.create_relation_row_failed", {
          targetDatabaseId,
          title: rowTitleText.trim(),
          error,
        })
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [mutationBusy, onCatalogChanged, retry, vaultGeneration, setMutationBusy, setMutationError],
  )

  const syncYamlForRow = React.useCallback(
    async (row: DatabaseRow) => {
      if (vaultGeneration === null) return
      setYamlSyncState({ rowId: row.noteId, busy: true, error: null, result: null })
      try {
        const result = await syncDatabaseYaml({
          expectedGeneration: vaultGeneration,
          databaseId,
          noteId: row.noteId,
          expectedRecordRevision: row.rowRevision,
        })
        logger.info("database.sync_yaml", {
          databaseId,
          noteId: row.noteId,
          changed: result.changed,
        })
        setYamlSyncState({ rowId: row.noteId, busy: false, error: null, result })
        if (result.changed) retry()
      } catch (error) {
        setYamlSyncState({
          rowId: row.noteId,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          result: null,
        })
      }
    },
    [databaseId, retry, vaultGeneration],
  )

  const resolveYamlForRow = React.useCallback(
    async (
      row: DatabaseRow,
      conflict: DatabaseYamlConflict,
      resolution: DatabaseYamlResolution,
      manualValueJson?: string,
    ) => {
      if (vaultGeneration === null) return
      setYamlSyncState((current) => ({
        rowId: row.noteId,
        busy: true,
        error: null,
        result: current?.rowId === row.noteId ? current.result : null,
      }))
      try {
        const result = await resolveDatabaseYamlConflict({
          expectedGeneration: vaultGeneration,
          databaseId,
          noteId: row.noteId,
          propertyId: conflict.propertyId,
          expectedNoteRevision: conflict.noteRevision,
          expectedRecordRevision: conflict.recordRevision,
          resolution,
          manualValueJson,
        })
        setYamlSyncState({ rowId: row.noteId, busy: false, error: null, result })
        if (result.changed) retry()
      } catch (error) {
        setYamlSyncState({
          rowId: row.noteId,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          result: null,
        })
      }
    },
    [databaseId, retry, vaultGeneration],
  )

  const moveRowToGroup = React.useCallback(
    async (row: DatabaseRow, laneKey: string) => {
      if (!groupField || groupField.kind !== "property" || vaultGeneration === null) return
      const groupProperty = database?.properties.find(
        (candidate) => candidate.propertyId === groupField.propertyId,
      )
      if (
        !groupProperty ||
        (groupProperty.propertyType !== "select" && groupProperty.propertyType !== "status")
      ) {
        throw new Error(t("databaseBoard.unsupportedValue"))
      }
      // A card without a value (the "No value" lane) has no stored value to copy.
      const typed = { type: groupProperty.propertyType }
      await applyDatabaseValueBatch({
        expectedGeneration: vaultGeneration,
        databaseId,
        operationId: `board-${Date.now()}-${row.noteId}`,
        cells: [
          {
            noteId: row.noteId,
            propertyId: groupField.propertyId,
            valueJson:
              laneKey === "__empty__" ? undefined : JSON.stringify({ ...typed, optionId: laneKey }),
            expectedRevision: row.rowRevision,
          },
        ],
      })
      retry()
      // The other views (table, list, gallery) hold their own copy of the rows: they reload too.
      useDatabaseStore.getState().invalidateHosts()
      void refreshHistoryStatus()
    },
    [database?.properties, databaseId, groupField, refreshHistoryStatus, retry, t, vaultGeneration],
  )

  return {
    rowDialogOpen,
    setRowDialogOpen,
    rowTitle,
    setRowTitle,
    createRow,
    openRowDialog,
    openRowDialogInLane,
    handleCreateRelationRow,
    moveRowToGroup,
    yamlSyncState,
    syncYamlForRow,
    resolveYamlForRow,
  }
}

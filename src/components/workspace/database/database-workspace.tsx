import * as React from "react"
import { CopyPlus, Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  applyDatabaseValueBatch,
  resolveDatabaseYamlConflict,
  syncDatabaseYaml,
  type DatabaseYamlConflict,
  type DatabaseYamlResolution,
  type DatabaseRow,
  type DatabaseYamlSyncResult,
} from "@/lib/storage"
import { useDatabaseStore, databaseHostKey, selectDatabaseHost } from "./database-store"
import { useDatabaseQuery } from "./use-database-query"
import { TableView } from "./table-view"
import { DatabaseSidePeek } from "./peek/database-side-peek"
import { BoardView, GalleryView, ListView } from "./layouts"

interface DatabaseWorkspaceProps {
  databaseId: string
  title: string
  onOpenInNewTab: () => void
}

export function DatabaseWorkspace({ databaseId, title, onOpenInNewTab }: DatabaseWorkspaceProps) {
  const { t } = useTranslation()
  const host = useDatabaseStore(selectDatabaseHost(databaseHostKey("tab", databaseId)))
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const database = useDatabaseStore((state) =>
    state.databases.find((candidate) => candidate.databaseId === databaseId),
  )
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null)
  const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null)
  const [yamlSyncState, setYamlSyncState] = React.useState<{
    rowId: string
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
  } | null>(null)
  const viewId = selectedViewId ?? database?.views[0]?.viewId ?? null
  const selectedView = database?.views.find((view) => view.viewId === viewId)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const {
    host: queriedHost,
    loadNextPage,
    retry,
  } = useDatabaseQuery({
    databaseId,
    vaultGeneration,
    enabled: Boolean(runtime?.enabled) && catalogStatus === "ready",
    viewId,
  })
  const activeHost = queriedHost ?? host
  const selectedRow = activeHost?.rows.find((row) => row.noteId === selectedRowId) ?? null
  const selectedRowIndex = selectedRow ? (activeHost?.rows.indexOf(selectedRow) ?? -1) : -1
  const selectAdjacentRow = (offset: number) => {
    if (!activeHost || selectedRowIndex < 0) return
    const next = activeHost.rows[selectedRowIndex + offset]
    if (next) setSelectedRowId(next.noteId)
  }

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
      const groupField = selectedView?.groupField
      if (!groupField || groupField.kind !== "property" || vaultGeneration === null) return
      let values: unknown
      try {
        values = JSON.parse(row.valuesJson)
      } catch {
        throw new Error(t("databaseBoard.invalidValues"))
      }
      const current =
        values && typeof values === "object"
          ? (values as Record<string, unknown>)[groupField.propertyId]
          : null
      const typed =
        current && typeof current === "object" ? (current as Record<string, unknown>) : null
      if (!typed || (typed.type !== "select" && typed.type !== "status")) {
        throw new Error(t("databaseBoard.unsupportedValue"))
      }
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
    },
    [databaseId, retry, selectedView?.groupField, t, vaultGeneration],
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex items-center gap-3 border-b border-border/70 px-6 py-4">
        <Database className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
          <p className="truncate text-xs text-muted-foreground">{databaseId}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenInNewTab}>
          <CopyPlus className="size-4" />
          {t("databaseWorkspace.openNewTab")}
        </Button>
      </header>
      {database && database.views.length > 0 && (
        <nav
          aria-label={t("databaseWorkspace.views")}
          className="flex gap-1 overflow-x-auto border-b border-border/70 px-6 py-2"
        >
          {database.views.map((view) => (
            <button
              key={view.viewId}
              type="button"
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${view.viewId === viewId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
              onClick={() => setSelectedViewId(view.viewId)}
            >
              {view.title}
            </button>
          ))}
        </nav>
      )}
      {activeHost?.rows.length || activeHost?.status === "loading" || activeHost?.error ? (
        <div className="flex min-h-0 flex-1">
          {selectedView?.layout === "list" ? (
            <ListView
              rows={activeHost.rows}
              loading={activeHost.status === "loading"}
              error={activeHost.error}
              hasNextPage={Boolean(activeHost.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={(row) => setSelectedRowId(row.noteId)}
            />
          ) : selectedView?.layout === "gallery" ? (
            <GalleryView
              rows={activeHost.rows}
              loading={activeHost.status === "loading"}
              error={activeHost.error}
              hasNextPage={Boolean(activeHost.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={(row) => setSelectedRowId(row.noteId)}
            />
          ) : selectedView?.layout === "board" ? (
            <BoardView
              rows={activeHost.rows}
              groupField={selectedView.groupField}
              loading={activeHost.status === "loading"}
              error={activeHost.error}
              hasNextPage={Boolean(activeHost.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={(row) => setSelectedRowId(row.noteId)}
              onMoveRow={moveRowToGroup}
            />
          ) : (
            <TableView
              rows={activeHost.rows}
              loading={activeHost.status === "loading"}
              error={activeHost.error}
              hasNextPage={Boolean(activeHost.nextCursor)}
              onLoadNextPage={loadNextPage}
              onRetry={retry}
              onRowSelect={(row) => setSelectedRowId(row.noteId)}
            />
          )}
          {selectedRow && (
            <DatabaseSidePeek
              row={selectedRow}
              canPrevious={selectedRowIndex > 0}
              canNext={selectedRowIndex < activeHost.rows.length - 1}
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
            />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-md space-y-3 text-center">
            <Database className="mx-auto size-8 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t("databaseWorkspace.placeholderTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("databaseWorkspace.placeholderDescription")}
            </p>
            <p className="text-xs text-muted-foreground">
              {runtime?.enabled && catalogStatus === "ready"
                ? t("databaseWorkspace.runtimeReady")
                : t("databaseWorkspace.runtimeUnavailable")}
              {activeHost?.diagnostics.length ? ` · ${activeHost.diagnostics.length}` : ""}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

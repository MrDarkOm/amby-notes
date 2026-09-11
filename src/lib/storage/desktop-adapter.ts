import i18n from "@/lib/i18n"
import { commands, type DatabaseSummary as BindingDatabaseSummary } from "@/lib/bindings"
import { unwrapCommand } from "./ipc-result"
import { joinStoragePath } from "./storage-path"
import type { StoragePort } from "./port"
import { NoteRevisionConflictError } from "./types"
import { unwrapDatabaseCommand } from "./database-port"
import type {
  DatabaseFieldRef,
  DatabaseFilterNode,
  DatabaseModuleState,
  CreateDatabaseRequest,
  CreatedDatabase,
  CreateDatabasePropertyRequest,
  DeleteDatabasePropertyRequest,
  DeletedDatabaseProperty,
  RenameDatabasePropertyRequest,
  RenamedDatabaseProperty,
  CreatedDatabaseProperty,
  DatabaseNoteContext,
  ReorderDatabasePropertiesRequest,
  ReorderedDatabaseProperties,
  RenameDatabaseRequest,
  RenamedDatabase,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSummary,
  DatabaseValueBatchRequest,
  DatabaseValueBatchResult,
  CreateDatabaseRowRequest,
  CreatedDatabaseRow,
  ImportDatabaseAssetRequest,
  ImportedDatabaseAsset,
  DatabaseYamlSyncRequest,
  DatabaseYamlSyncResult,
  DatabaseYamlResolveRequest,
} from "./database-types"
import type {
  CredentialInfo,
  CustomProperty,
  FileMetadata,
  FsMutationResult,
  HistoryCleanupPreview,
  HistoryCleanupResult,
  HistoryRetention,
  HistoryStats,
  IdMigrationRecovery,
  IdMigrationRecoveryAction,
  ImportedAsset,
  LayerKind,
  LayerResult,
  LinkGraph,
  LoadVaultResult,
  MutationOutcome,
  NoteReadOutcome,
  NoteLayers,
  NoteProperties,
  RefactorPreview,
  SearchResult,
  SnapshotEntry,
  SnapshotText,
  TrashEntry,
  TreeItem,
  VaultPreflight,
  VaultTagEntry,
  WriteNoteOutcome,
} from "./types"

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(cmd, args)
}

function reportIndexOutcome(outcome: Pick<MutationOutcome, "indexState" | "warnings">): void {
  if (outcome.indexState === "rebuildRequired" && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("amby:index-rebuild-required", { detail: outcome }))
  }
}

async function unwrapMutation(command: Promise<unknown>): Promise<FsMutationResult> {
  const outcome = await unwrapCommand<MutationOutcome>(command as never)
  reportIndexOutcome(outcome)
  return outcome.mutation
}

function toBindingField(field: DatabaseFieldRef) {
  return field.kind === "system"
    ? { kind: "system" as const, field: field.field }
    : { kind: "property" as const, property_id: field.propertyId }
}

function fromBindingField(field: {
  kind: "system" | "property"
  field?: string
  property_id?: string
}): DatabaseFieldRef {
  return field.kind === "system"
    ? { kind: "system", field: field.field ?? "" }
    : { kind: "property", propertyId: field.property_id ?? "" }
}

function fromBindingSummary(summary: BindingDatabaseSummary): DatabaseSummary {
  return {
    databaseId: summary.databaseId,
    title: summary.title,
    icon: summary.icon,
    attachedNoteId: summary.attachedNoteId,
    manifestRevision: summary.manifestRevision,
    locked: summary.locked,
    properties: summary.properties,
    views: summary.views.map((view) => ({
      viewId: view.viewId,
      title: view.title,
      layout: view.layout,
      revision: view.revision,
      groupField: view.groupField ? fromBindingField(view.groupField) : null,
    })),
    templates: summary.templates.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      revision: template.revision,
    })),
    diagnostics: summary.diagnostics,
  }
}

function toBindingFilter(filter: DatabaseFilterNode):
  | { kind: "group"; operator: string; children: ReturnType<typeof toBindingFilter>[] }
  | {
      kind: "condition"
      field: ReturnType<typeof toBindingField>
      operator: string
      value: string | null
    } {
  if (filter.kind === "group") {
    return {
      kind: "group",
      operator: filter.operator,
      children: filter.children.map(toBindingFilter),
    }
  }
  return {
    kind: "condition",
    field: toBindingField(filter.field),
    operator: filter.operator,
    value: filter.value ?? null,
  }
}

function toBindingQueryRequest(request: DatabaseQueryRequest) {
  const source =
    request.source.kind === "savedView"
      ? {
          kind: "savedView" as const,
          view_id: request.source.viewId,
          expected_revision: request.source.expectedRevision ?? null,
        }
      : {
          kind: "inline" as const,
          spec: {
            filter: request.source.spec.filter ? toBindingFilter(request.source.spec.filter) : null,
            sorts: request.source.spec.sorts.map((sort) => ({
              field: toBindingField(sort.field),
              direction: sort.direction,
              nulls: sort.nulls,
            })),
          },
        }
  return {
    expectedGeneration: request.expectedGeneration,
    databaseId: request.databaseId,
    source,
    page: {
      limit: request.page.limit,
      cursor: request.page.cursor ?? null,
    },
  }
}

export class DesktopAdapter implements StoragePort {
  async getDatabaseModuleState(): Promise<DatabaseModuleState> {
    return unwrapDatabaseCommand(await commands.getDatabaseModuleState())
  }

  async setDatabaseModuleEnabled(
    enabled: boolean,
    expectedGeneration: number,
  ): Promise<DatabaseModuleState> {
    return unwrapDatabaseCommand(
      await commands.setDatabaseModuleEnabled(enabled, expectedGeneration),
    )
  }

  async rebuildDatabaseProjection(): Promise<DatabaseModuleState> {
    return unwrapDatabaseCommand(await commands.rebuildDatabaseProjection())
  }

  async createDatabase(request: CreateDatabaseRequest): Promise<CreatedDatabase> {
    return unwrapDatabaseCommand(
      await commands.createDatabase({
        expectedGeneration: request.expectedGeneration,
        mode: request.mode,
        parentPath: request.parentPath ?? null,
        notePath: request.notePath ?? null,
        name: request.name,
      }),
    )
  }

  async createDatabaseProperty(
    request: CreateDatabasePropertyRequest,
  ): Promise<CreatedDatabaseProperty> {
    return unwrapDatabaseCommand(
      await commands.createDatabaseProperty({
        ...request,
        beforePropertyId: request.beforePropertyId ?? null,
        options: request.options ?? [],
      }),
    )
  }

  async deleteDatabaseProperty(
    request: DeleteDatabasePropertyRequest,
  ): Promise<DeletedDatabaseProperty> {
    return unwrapDatabaseCommand(await commands.deleteDatabaseProperty(request))
  }

  async renameDatabaseProperty(
    request: RenameDatabasePropertyRequest,
  ): Promise<RenamedDatabaseProperty> {
    return unwrapDatabaseCommand(await commands.renameDatabaseProperty(request))
  }

  async getDatabaseNoteContext(noteId: string): Promise<DatabaseNoteContext | null> {
    return unwrapDatabaseCommand(await commands.getDatabaseNoteContext(noteId))
  }

  async reorderDatabaseProperties(
    request: ReorderDatabasePropertiesRequest,
  ): Promise<ReorderedDatabaseProperties> {
    return unwrapDatabaseCommand(await commands.reorderDatabaseProperties(request))
  }

  async renameDatabase(request: RenameDatabaseRequest): Promise<RenamedDatabase> {
    return unwrapDatabaseCommand(await commands.renameDatabase(request))
  }

  async applyDatabaseValueBatch(
    request: DatabaseValueBatchRequest,
  ): Promise<DatabaseValueBatchResult> {
    return unwrapDatabaseCommand(
      await commands.applyDatabaseValueBatch({
        expectedGeneration: request.expectedGeneration,
        databaseId: request.databaseId,
        operationId: request.operationId,
        cells: request.cells.map((cell) => ({
          noteId: cell.noteId,
          propertyId: cell.propertyId,
          valueJson: cell.valueJson ?? null,
          expectedRevision: cell.expectedRevision,
        })),
      }),
    )
  }

  async createDatabaseRow(request: CreateDatabaseRowRequest): Promise<CreatedDatabaseRow> {
    return unwrapDatabaseCommand(await commands.createDatabaseRow(request))
  }

  async importDatabaseAsset(request: ImportDatabaseAssetRequest): Promise<ImportedDatabaseAsset> {
    return unwrapDatabaseCommand(
      await commands.importDatabaseAsset({
        expectedGeneration: request.expectedGeneration,
        databaseId: request.databaseId,
        noteId: request.noteId,
        sourcePath: request.sourcePath,
      }),
    )
  }

  async syncDatabaseYaml(request: DatabaseYamlSyncRequest): Promise<DatabaseYamlSyncResult> {
    return unwrapDatabaseCommand(
      await commands.syncDatabaseYaml({
        expectedGeneration: request.expectedGeneration,
        databaseId: request.databaseId,
        noteId: request.noteId,
        expectedRecordRevision: request.expectedRecordRevision,
      }),
    )
  }

  async resolveDatabaseYamlConflict(
    request: DatabaseYamlResolveRequest,
  ): Promise<DatabaseYamlSyncResult> {
    return unwrapDatabaseCommand(
      await commands.resolveDatabaseYamlConflict({
        expectedGeneration: request.expectedGeneration,
        databaseId: request.databaseId,
        noteId: request.noteId,
        propertyId: request.propertyId,
        expectedNoteRevision: request.expectedNoteRevision,
        expectedRecordRevision: request.expectedRecordRevision,
        resolution: request.resolution,
        manualValueJson: request.manualValueJson ?? null,
      }),
    )
  }

  async listDatabases(): Promise<DatabaseSummary[]> {
    const result = unwrapDatabaseCommand(await commands.listDatabases())
    return result.map(fromBindingSummary)
  }

  async queryDatabase(request: DatabaseQueryRequest): Promise<DatabaseQueryResult> {
    const result = unwrapDatabaseCommand(
      await commands.queryDatabase(toBindingQueryRequest(request)),
    )
    return { ...result, database: fromBindingSummary(result.database) }
  }

  async openVault(): Promise<string | null> {
    return unwrapCommand(commands.openVault())
  }

  async startVaultWatcher(_vaultPath: string): Promise<void> {
    return unwrapCommand(commands.startVaultWatcher())
  }

  async stopVaultWatcher(): Promise<void> {
    return unwrapCommand(commands.stopVaultWatcher())
  }

  async loadVaultData(vaultPath: string): Promise<LoadVaultResult> {
    return unwrapCommand(commands.loadVault(vaultPath))
  }

  async loadActiveVaultData(): Promise<LoadVaultResult> {
    return unwrapCommand(commands.loadActiveVault())
  }

  async preflightVault(vaultPath: string): Promise<VaultPreflight> {
    return unwrapCommand(commands.preflightVault(vaultPath))
  }

  async applyIdMigration(vaultPath: string): Promise<void> {
    await unwrapCommand(commands.applyIdMigration(vaultPath))
  }

  async inspectIdMigrations(vaultPath: string): Promise<IdMigrationRecovery[]> {
    return unwrapCommand(commands.inspectIdMigrations(vaultPath))
  }

  async recoverIdMigration(
    vaultPath: string,
    journalPath: string,
    action: IdMigrationRecoveryAction,
  ): Promise<IdMigrationRecovery> {
    return unwrapCommand(commands.recoverIdMigration(vaultPath, journalPath, action))
  }

  async listFiles(_vaultPath: string): Promise<TreeItem[]> {
    return unwrapCommand(commands.listFiles())
  }

  async searchNotes(query: string): Promise<SearchResult[]> {
    return unwrapCommand(commands.searchNotes(query))
  }

  async readFile(path: string): Promise<string> {
    return unwrapCommand(commands.readFile(path))
  }

  async readNote(_vaultPath: string, noteId: string): Promise<NoteReadOutcome> {
    // A file can arrive through the watcher after vault activation. Re-run the
    // safe identity migration before opening it so notes without amby-id become
    // editable immediately (malformed/conflicting files remain untouched).
    await unwrapCommand(commands.applyIdMigration(_vaultPath))
    return unwrapCommand(commands.readNote(noteId))
  }

  async writeFile(path: string, content: string): Promise<void> {
    return unwrapCommand(commands.writeFile(path, content))
  }

  async writeNote(
    _vaultPath: string,
    noteId: string,
    content: string,
    expectedGeneration: number | null,
    expectedRevision: string,
    originWindow: string,
  ): Promise<WriteNoteOutcome> {
    if (expectedGeneration === null) throw new Error("No active vault generation")
    const result = await commands.writeNote({
      expectedGeneration,
      noteId,
      content,
      expectedRevision,
      originWindow,
    })
    if (result.status === "error") {
      if (result.error.kind === "revisionConflict") {
        throw new NoteRevisionConflictError(result.error.actual_revision)
      }
      throw new Error(result.error.message)
    }
    const outcome = result.data
    reportIndexOutcome(outcome)
    return outcome
  }

  async restoreDeletedNote(
    _vaultPath: string,
    noteId: string,
    path: string,
    content: string,
    sourceTemplate: string,
    expectedGeneration: number | null,
    originWindow: string,
  ): Promise<WriteNoteOutcome> {
    if (expectedGeneration === null) throw new Error("No active vault generation")
    const result = await commands.restoreDeletedNote({
      expectedGeneration,
      noteId,
      path,
      content,
      sourceTemplate,
      originWindow,
    })
    if (result.status === "error") {
      if (result.error.kind === "revisionConflict") {
        throw new NoteRevisionConflictError(result.error.actual_revision)
      }
      throw new Error(result.error.message)
    }
    const outcome = result.data
    reportIndexOutcome(outcome)
    return outcome
  }

  async saveConflictCopy(path: string, content: string): Promise<string> {
    return unwrapCommand(commands.saveConflictCopy(path, content))
  }

  async createNote(
    _vaultPath: string,
    parentPath: string,
    name: string,
  ): Promise<FsMutationResult> {
    return unwrapMutation(commands.createNote(parentPath, name))
  }

  async createFolder(_vaultPath: string, name: string): Promise<string> {
    const path = _vaultPath ? joinStoragePath(_vaultPath, name) : name
    await unwrapCommand(commands.createFolder(path))
    return path
  }

  async createCanvasFile(
    vaultPath: string,
    parentPath: string | null,
    name: string,
  ): Promise<string> {
    return unwrapCommand(commands.createCanvas(parentPath ?? vaultPath, name))
  }

  async attachCanvasToNote(_vaultPath: string, canvasPath: string): Promise<FsMutationResult> {
    return unwrapMutation(commands.attachCanvasToNote(canvasPath))
  }

  async renameItem(_vaultPath: string, path: string, newName: string): Promise<FsMutationResult> {
    return unwrapMutation(commands.renameItem(path, newName))
  }

  async moveItem(
    _vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<FsMutationResult> {
    return unwrapMutation(commands.moveItem(sourcePath, targetPath))
  }

  async deleteItem(_vaultPath: string, path: string): Promise<FsMutationResult> {
    return unwrapMutation(commands.deleteItem(path))
  }

  async archiveItem(_vaultPath: string, path: string): Promise<FsMutationResult> {
    return unwrapMutation(commands.archiveItem(path))
  }

  async noteLayers(notePath: string): Promise<NoteLayers> {
    return unwrapCommand(commands.noteLayers(notePath))
  }

  async createLayer(notePath: string, kind: LayerKind): Promise<LayerResult> {
    return unwrapCommand(commands.createLayer(notePath, kind))
  }

  async unlinkLayer(
    _vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
    return unwrapMutation(commands.unlinkLayer(notePath, kind))
  }

  async deleteLayer(
    _vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
    return unwrapMutation(commands.deleteLayer(notePath, kind))
  }

  async getNoteMetadata(_vaultPath: string, noteId: string): Promise<FileMetadata> {
    return unwrapCommand(commands.getNoteMetadata(noteId))
  }

  async getFileMetadata(path: string): Promise<FileMetadata> {
    return unwrapCommand(commands.getFileMetadata(path))
  }

  async getNoteProperties(_vaultPath: string, noteId: string): Promise<NoteProperties> {
    return unwrapCommand(commands.getNoteProperties(noteId))
  }

  async upsertCustomProperty(
    _vaultPath: string,
    noteId: string,
    property: CustomProperty,
  ): Promise<CustomProperty> {
    return unwrapCommand(commands.upsertCustomProperty(noteId, property))
  }

  async deleteCustomProperty(
    _vaultPath: string,
    noteId: string,
    propertyId: string,
  ): Promise<void> {
    await unwrapCommand(commands.deleteCustomProperty(noteId, propertyId))
  }

  async reorderCustomProperties(
    _vaultPath: string,
    noteId: string,
    propertyIds: string[],
  ): Promise<void> {
    await unwrapCommand(commands.reorderCustomProperties(noteId, propertyIds))
  }

  async backupCustomProperties(_vaultPath: string, noteId: string): Promise<string> {
    return unwrapCommand(commands.backupCustomProperties(noteId))
  }

  async getLinkGraph(_vaultPath: string): Promise<LinkGraph> {
    return unwrapCommand(commands.getLinkGraph())
  }

  async listTags(_vaultPath: string): Promise<VaultTagEntry[]> {
    return unwrapCommand(commands.listTags())
  }

  async listSnapshots(sourcePath: string): Promise<SnapshotEntry[]> {
    return unwrapCommand(commands.listSnapshots(sourcePath))
  }

  async getHistoryStats(): Promise<HistoryStats> {
    return unwrapCommand(commands.getHistoryStats())
  }

  async previewHistoryCleanup(
    retention: HistoryRetention,
    sourcePath?: string,
  ): Promise<HistoryCleanupPreview> {
    return unwrapCommand(commands.previewHistoryCleanup(retention, sourcePath ?? null))
  }

  async cleanupHistory(
    retention: HistoryRetention,
    sourcePath?: string,
  ): Promise<HistoryCleanupResult> {
    return unwrapCommand(commands.cleanupHistory(retention, sourcePath ?? null))
  }

  async restoreSnapshot(snapshotId: string): Promise<string> {
    return unwrapCommand(commands.restoreSnapshot(snapshotId))
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    return unwrapCommand(commands.deleteSnapshot(snapshotId))
  }

  async readSnapshotText(snapshotId: string): Promise<SnapshotText> {
    return unwrapCommand(commands.readSnapshotText(snapshotId))
  }

  async listTrash(): Promise<TrashEntry[]> {
    return unwrapCommand(commands.listTrash())
  }

  async restoreTrash(trashId: string): Promise<FsMutationResult> {
    return unwrapMutation(commands.restoreTrash(trashId))
  }
  async purgeTrash(trashId: string): Promise<void> {
    await unwrapCommand(commands.purgeTrash(trashId))
  }

  async previewRenameRefactor(
    _vaultPath: string,
    path: string,
    newName: string,
  ): Promise<RefactorPreview> {
    return unwrapCommand(commands.previewRenameRefactor(path, newName))
  }

  async previewMoveRefactor(
    _vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<RefactorPreview> {
    return unwrapCommand(commands.previewMoveRefactor(sourcePath, targetPath))
  }

  async openInExplorer(path: string): Promise<void> {
    await unwrapCommand(commands.openInExplorer(path))
  }

  async pickAssetFile(imagesOnly: boolean): Promise<string | null> {
    return unwrapCommand(commands.pickAssetFile(imagesOnly))
  }

  async importAsset(
    _vaultPath: string,
    notePath: string,
    sourcePath: string,
  ): Promise<ImportedAsset | null> {
    return unwrapCommand(commands.importAsset(notePath, sourcePath))
  }

  async importAssetBytes(
    _vaultPath: string,
    notePath: string,
    bytes: Uint8Array,
    suggestedExt: string,
  ): Promise<ImportedAsset | null> {
    return unwrapCommand(commands.importAssetBytes(notePath, Array.from(bytes), suggestedExt))
  }

  async toAssetUrl(absPath: string): Promise<string> {
    const { convertFileSrc } = await import("@tauri-apps/api/core")
    return convertFileSrc(absPath)
  }

  async exportTextFile(contents: string, defaultName: string): Promise<string | null> {
    return unwrapCommand(commands.exportTextFile(contents, defaultName))
  }

  async importTextFile(): Promise<string | null> {
    return unwrapCommand(commands.importTextFile())
  }

  async confirmAction(message: string): Promise<boolean> {
    const result = await invoke<string>("plugin:dialog|message", {
      message,
      title: i18n.t("app.name"),
      kind: "warning",
      buttons: "OkCancel",
    })
    return result === "Ok"
  }

  async showErrorMessage(message: string): Promise<void> {
    await invoke("plugin:dialog|message", {
      message,
      title: i18n.t("app.name"),
      kind: "error",
      buttons: "Ok",
    })
  }

  async readGlobalRaw(file: string): Promise<string | null> {
    return unwrapCommand(commands.readAppData(file))
  }

  async writeGlobalRaw(file: string, contents: string): Promise<void> {
    return unwrapCommand(commands.writeAppData(file, contents))
  }

  async readVaultRaw(rel: string): Promise<string | null> {
    return unwrapCommand(commands.readVaultMeta(rel))
  }

  async writeVaultRaw(rel: string, contents: string): Promise<void> {
    return unwrapCommand(commands.writeVaultMeta(rel, contents))
  }

  async deleteVaultMeta(rel: string): Promise<void> {
    await unwrapCommand(commands.deleteVaultMeta(rel))
  }

  async storeAiCredential(credentialId: string, secret: string): Promise<void> {
    await unwrapCommand(commands.storeAiCredential(credentialId, secret))
  }

  async deleteAiCredential(credentialId: string): Promise<void> {
    await unwrapCommand(commands.deleteAiCredential(credentialId))
  }

  async inspectAiCredential(credentialId: string): Promise<CredentialInfo> {
    return unwrapCommand(commands.inspectAiCredential(credentialId))
  }
}

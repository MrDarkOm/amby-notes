import type { Result } from "@/lib/bindings"
import {
  databaseErrorMessage,
  DatabaseOperationError,
  type DatabaseError,
  type CreateDatabaseRequest,
  type CreatedDatabase,
  type CreateDatabasePropertyRequest,
  type CreatedDatabaseProperty,
  type DeleteDatabasePropertyRequest,
  type DeletedDatabaseProperty,
  type RenameDatabasePropertyRequest,
  type RenamedDatabaseProperty,
  type RenameDatabaseRequest,
  type RenamedDatabase,
  type DatabaseValueBatchRequest,
  type DatabaseValueBatchResult,
  type CreateDatabaseRowRequest,
  type CreatedDatabaseRow,
  type ImportDatabaseAssetRequest,
  type ImportedDatabaseAsset,
  type DatabaseYamlSyncRequest,
  type DatabaseYamlSyncResult,
  type DatabaseYamlResolveRequest,
  type DatabaseModuleState,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
  type DatabaseSummary,
  type DatabaseNoteContext,
  type ReorderDatabasePropertiesRequest,
  type ReorderedDatabaseProperties,
} from "./database-types"

export interface DatabasePort {
  getDatabaseModuleState(): Promise<DatabaseModuleState>
  setDatabaseModuleEnabled(
    enabled: boolean,
    expectedGeneration: number,
  ): Promise<DatabaseModuleState>
  rebuildDatabaseProjection(): Promise<DatabaseModuleState>
  createDatabase(request: CreateDatabaseRequest): Promise<CreatedDatabase>
  createDatabaseProperty(request: CreateDatabasePropertyRequest): Promise<CreatedDatabaseProperty>
  deleteDatabaseProperty(request: DeleteDatabasePropertyRequest): Promise<DeletedDatabaseProperty>
  renameDatabaseProperty(request: RenameDatabasePropertyRequest): Promise<RenamedDatabaseProperty>
  renameDatabase(request: RenameDatabaseRequest): Promise<RenamedDatabase>
  applyDatabaseValueBatch(request: DatabaseValueBatchRequest): Promise<DatabaseValueBatchResult>
  createDatabaseRow(request: CreateDatabaseRowRequest): Promise<CreatedDatabaseRow>
  importDatabaseAsset(request: ImportDatabaseAssetRequest): Promise<ImportedDatabaseAsset>
  syncDatabaseYaml(request: DatabaseYamlSyncRequest): Promise<DatabaseYamlSyncResult>
  resolveDatabaseYamlConflict(request: DatabaseYamlResolveRequest): Promise<DatabaseYamlSyncResult>
  listDatabases(): Promise<DatabaseSummary[]>
  getDatabaseNoteContext(noteId: string): Promise<DatabaseNoteContext | null>
  reorderDatabaseProperties(
    request: ReorderDatabasePropertiesRequest,
  ): Promise<ReorderedDatabaseProperties>
  queryDatabase(request: DatabaseQueryRequest): Promise<DatabaseQueryResult>
}

/** Convert typed domain errors while keeping transport failures untouched. */
export function unwrapDatabaseCommand<T>(result: Result<T, DatabaseError>): T {
  if (result.status === "ok") return result.data
  throw new DatabaseOperationError(result.error.kind, databaseErrorMessage(result.error))
}

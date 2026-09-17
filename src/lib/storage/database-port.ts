import type { Result } from "@/lib/bindings"
import {
  databaseErrorMessage,
  DatabaseOperationError,
  type DatabaseError,
  type CreateDatabaseRequest,
  type CreatedDatabase,
  type CreateDatabasePropertyRequest,
  type CreatedDatabaseProperty,
  type ChangeDatabasePropertyTypeRequest,
  type ChangedDatabasePropertyType,
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
  type CreateDatabaseViewRequest,
  type DatabaseViewDocument,
  type DatabaseViewMutationResult,
  type DatabaseViewRequest,
  type DeleteDatabaseViewRequest,
  type RenameDatabaseViewRequest,
  type ReorderDatabaseViewsRequest,
  type UpdateDatabaseViewConfigRequest,
  type DatabaseAggregateRequest,
  type DatabaseAggregateResult,
  type DatabaseChangedPayload,
  type UpdateDatabaseRelationValueRequest,
  type UpdateDatabaseRelationValueResult,
} from "./database-types"

export interface DatabasePort {
  getDatabaseModuleState(): Promise<DatabaseModuleState>
  setDatabaseModuleEnabled(
    enabled: boolean,
    expectedGeneration: number,
  ): Promise<DatabaseModuleState>
  rebuildDatabaseProjection(): Promise<DatabaseModuleState>
  refreshDatabaseChange(change: DatabaseChangedPayload): Promise<DatabaseModuleState>
  createDatabase(request: CreateDatabaseRequest): Promise<CreatedDatabase>
  createDatabaseProperty(request: CreateDatabasePropertyRequest): Promise<CreatedDatabaseProperty>
  changeDatabasePropertyType(
    request: ChangeDatabasePropertyTypeRequest,
  ): Promise<ChangedDatabasePropertyType>
  deleteDatabaseProperty(request: DeleteDatabasePropertyRequest): Promise<DeletedDatabaseProperty>
  renameDatabaseProperty(request: RenameDatabasePropertyRequest): Promise<RenamedDatabaseProperty>
  renameDatabase(request: RenameDatabaseRequest): Promise<RenamedDatabase>
  applyDatabaseValueBatch(request: DatabaseValueBatchRequest): Promise<DatabaseValueBatchResult>
  updateDatabaseRelationValue(
    request: UpdateDatabaseRelationValueRequest,
  ): Promise<UpdateDatabaseRelationValueResult>
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
  getDatabaseView(request: DatabaseViewRequest): Promise<DatabaseViewDocument>
  createDatabaseView(request: CreateDatabaseViewRequest): Promise<DatabaseViewDocument>
  renameDatabaseView(request: RenameDatabaseViewRequest): Promise<DatabaseViewMutationResult>
  updateDatabaseViewConfig(
    request: UpdateDatabaseViewConfigRequest,
  ): Promise<DatabaseViewMutationResult>
  duplicateDatabaseView(request: DatabaseViewRequest): Promise<DatabaseViewDocument>
  deleteDatabaseView(request: DeleteDatabaseViewRequest): Promise<DatabaseViewMutationResult>
  reorderDatabaseViews(request: ReorderDatabaseViewsRequest): Promise<DatabaseViewMutationResult>
  setDefaultDatabaseView(request: DatabaseViewRequest): Promise<DatabaseViewMutationResult>
  aggregateDatabase(request: DatabaseAggregateRequest): Promise<DatabaseAggregateResult>
}

/** Convert typed domain errors while keeping transport failures untouched. */
export function unwrapDatabaseCommand<T>(result: Result<T, DatabaseError>): T {
  if (result.status === "ok") return result.data
  throw new DatabaseOperationError(
    result.error.kind,
    databaseErrorMessage(result.error),
    result.error.kind === "failed" ? result.error.code : undefined,
  )
}

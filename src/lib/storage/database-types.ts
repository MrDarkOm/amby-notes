export interface ProjectionVersion {
  epoch: string
  seq: number
}

export interface DatabaseModuleState {
  enabled: boolean
  vaultGeneration: number | null
  projection: ProjectionVersion | null
}

export interface DatabaseChangedPayload {
  kind: string
  path: string
  containerPath: string
  generation: number
  requiresFullRebuild: boolean
}

/** A list item has no absolute or renderer-resolvable filesystem path. */
export interface DatabaseSummary {
  databaseId: string
  title: string
  icon: string | null
  attachedNoteId: string | null
  manifestRevision: string
  locked: boolean
  properties: DatabasePropertySummary[]
  views: DatabaseViewSummary[]
  templates: DatabaseTemplateSummary[]
  diagnostics: DatabaseDiagnostic[]
}

export interface DatabasePropertySummary {
  propertyId: string
  name: string
  propertyType: string
  configJson: string
  options: DatabaseOptionSummary[]
}

export interface DatabaseOptionSummary {
  optionId: string
  name: string
  color: string
}

export interface DatabaseViewSummary {
  viewId: string
  title: string
  layout: string
  revision: string
  groupField: DatabaseFieldRef | null
}

export interface DatabaseTemplateSummary {
  templateId: string
  name: string
  revision: string
}

export type DatabaseRowTemplate =
  { kind: "empty" } | { kind: "default" } | { kind: "template"; templateId: string }

export type DatabaseCreateMode = "standalone" | "attached"

export interface CreateDatabaseRequest {
  expectedGeneration: number
  mode: DatabaseCreateMode
  parentPath?: string
  notePath?: string
  name: string
}

export interface CreatedDatabase {
  databaseId: string
  title: string
  manifestRevision: string
  viewId: string
  viewRevision: string
  manifestPath: string
  viewPath: string
  notePath: string | null
  warnings: string[]
}

export interface CreateDatabasePropertyRequest {
  expectedGeneration: number
  databaseId: string
  expectedManifestRevision: string
  name: string
  propertyType: string
  beforePropertyId?: string
  options?: string[]
}

export interface RenameDatabaseRequest {
  expectedGeneration: number
  databaseId: string
  expectedManifestRevision: string
  name: string
}

export interface RenamedDatabase {
  databaseId: string
  title: string
  manifestRevision: string
  warnings: string[]
}

export interface CreatedDatabaseProperty {
  databaseId: string
  propertyId: string
  name: string
  propertyType: string
  manifestRevision: string
  warnings: string[]
}

export interface RenameDatabasePropertyRequest {
  expectedGeneration: number
  databaseId: string
  propertyId: string
  expectedManifestRevision: string
  name: string
}

export interface RenamedDatabaseProperty {
  databaseId: string
  propertyId: string
  name: string
  manifestRevision: string
  warnings: string[]
}

export interface DeleteDatabasePropertyRequest {
  expectedGeneration: number
  databaseId: string
  propertyId: string
  expectedManifestRevision: string
}

export interface DeletedDatabaseProperty {
  databaseId: string
  propertyId: string
  manifestRevision: string
  warnings: string[]
}

export interface DatabaseValueMutation {
  noteId: string
  propertyId: string
  valueJson?: string
  expectedRevision: string
}

export interface DatabaseValueBatchRequest {
  expectedGeneration: number
  databaseId: string
  operationId: string
  cells: DatabaseValueMutation[]
}

export interface DatabaseNoteRevision {
  noteId: string
  revision: string
}

export interface DatabaseValueBatchResult {
  operationId: string
  databaseId: string
  revisions: DatabaseNoteRevision[]
  warnings: string[]
}

export interface CreateDatabaseRowRequest {
  expectedGeneration: number
  databaseId: string
  title: string
  template: DatabaseRowTemplate
}

export interface CreatedDatabaseRow {
  databaseId: string
  noteId: string
  title: string
  notePath: string
  recordPath: string
  recordRevision: string
  warnings: string[]
}

export interface ImportDatabaseAssetRequest {
  expectedGeneration: number
  databaseId: string
  noteId: string
  sourcePath: string
}

export interface ImportedDatabaseAsset {
  databaseId: string
  noteId: string
  assetId: string
  name: string
  relativePath: string
  mimeType: string
  sizeBytes: number
}

export interface DatabaseYamlSyncRequest {
  expectedGeneration: number
  databaseId: string
  noteId: string
  expectedRecordRevision: string
}

export type DatabaseYamlResolution = "shard" | "yaml" | "manual"

export interface DatabaseYamlResolveRequest {
  expectedGeneration: number
  databaseId: string
  noteId: string
  propertyId: string
  expectedNoteRevision: string
  expectedRecordRevision: string
  resolution: DatabaseYamlResolution
  manualValueJson?: string
}

export interface DatabaseYamlConflict {
  databaseId: string
  noteId: string
  propertyId: string
  yamlKey: string
  baseJson: string
  shardJson: string
  yamlJson: string
  noteRevision: string
  recordRevision: string
}

export interface DatabaseYamlSyncResult {
  databaseId: string
  noteId: string
  noteRevision: string
  recordRevision: string
  changed: boolean
  conflicts: DatabaseYamlConflict[]
  warnings: string[]
}

export type DatabaseFieldRef =
  { kind: "system"; field: string } | { kind: "property"; propertyId: string }

export type DatabaseFilterNode =
  | { kind: "group"; operator: string; children: DatabaseFilterNode[] }
  | { kind: "condition"; field: DatabaseFieldRef; operator: string; value?: string }

export interface DatabaseSortSpec {
  field: DatabaseFieldRef
  direction: string
  nulls: string
}

export interface DatabaseQuerySpec {
  filter?: DatabaseFilterNode
  sorts: DatabaseSortSpec[]
}

export interface DatabaseQueryRequest {
  expectedGeneration: number
  databaseId: string
  source:
    | { kind: "savedView"; viewId: string; expectedRevision?: string }
    | { kind: "inline"; spec: DatabaseQuerySpec }
  page: { limit: number; cursor?: string }
}

export interface DatabaseRow {
  noteId: string
  title: string
  relativePath: string
  parentNoteId: string | null
  depth: number
  categoryPath: string[]
  valuesJson: string
  rowRevision: string
}

export interface DatabaseNoteContext {
  vaultGeneration: number
  databaseId: string
  databaseTitle: string
  databaseIcon: string | null
  manifestRevision: string
  locked: boolean
  properties: DatabasePropertySummary[]
  row: DatabaseRow
}

export interface ReorderDatabasePropertiesRequest {
  expectedGeneration: number
  databaseId: string
  expectedManifestRevision: string
  propertyIds: string[]
}

export interface ReorderedDatabaseProperties {
  databaseId: string
  propertyIds: string[]
  manifestRevision: string
  warnings: string[]
}

export interface DatabaseDiagnostic {
  code: string
  severity: string
  path: string
  message: string
}

export interface DatabaseQueryResult {
  database: DatabaseSummary
  projection: ProjectionVersion
  rows: DatabaseRow[]
  nextCursor: string | null
  diagnostics: DatabaseDiagnostic[]
}

export type DatabaseError =
  | { kind: "moduleDisabled" }
  | { kind: "vaultNotOpen" }
  | { kind: "vaultGenerationConflict"; actual_generation: number }
  | { kind: "failed"; code: string; message: string }

export class DatabaseOperationError extends Error {
  constructor(
    public readonly kind: DatabaseError["kind"],
    message: string,
  ) {
    super(message)
    this.name = "DatabaseOperationError"
  }
}

export function databaseErrorMessage(error: DatabaseError): string {
  if (error.kind === "failed") return error.message
  if (error.kind === "moduleDisabled") return "Database module is disabled"
  if (error.kind === "vaultNotOpen") return "No vault is open"
  return `Vault changed before database operation (generation ${error.actual_generation})`
}

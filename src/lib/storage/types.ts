export interface TreeItem {
  id: string
  path: string
  name: string
  type: "folder" | "file" | "canvas"
  icon?: string
  /** Filesystem timestamps in Unix seconds, used by the file-panel sorter. */
  created?: number
  modified?: number
  children?: TreeItem[]
}

export interface FileMetadata {
  created?: number
  modified?: number
  word_count: number
}

export interface FrontmatterProperty {
  key: string
  value: string
  valueKind: string
}

export interface CustomProperty {
  id: string
  name: string
  icon: string
  propertyType: string
  value: string
  settings: string
}

export interface NoteProperties {
  hasFrontmatter: boolean
  properties: FrontmatterProperty[]
  parseError?: string
  customProperties: CustomProperty[]
}

export interface SnapshotEntry {
  id: string
  createdAtMs: number
  reason: string
  sizeBytes: number
}

export interface SnapshotText {
  sourcePath: string
  content: string
}

export interface RefactorPreview {
  notes: number
  replacements: number
}

export interface TrashEntry {
  id: string
  originalPath: string
  deletedAtMs: number
  name: string
}

interface IndexedNote {
  id: string
  path: string
  title: string
  modified?: number
  wordCount: number
}

interface SyncReport {
  inserted: number
  updated: number
  deleted: number
  warnings: string[]
  pathToId: Record<string, string>
}

export interface LoadVaultResult {
  generation: number
  tree: TreeItem[]
  notes: IndexedNote[]
  sync: SyncReport
}

export interface VaultPreflight {
  notes: number
  attachments: number
  malformedFrontmatter: string[]
  userManagedIds: string[]
  duplicateIds: string[]
  plannedIdWrites: string[]
  unfinishedMigrations: IdMigrationRecovery[]
}

type IdMigrationStatus = "planned" | "inProgress" | "completed" | "rolledBack"
type IdMigrationFileStatus = "pending" | "backupCreated" | "applied" | "rolledBack"
export type IdMigrationRecoveryAction = "resume" | "rollback" | "inspectOnly"

interface IdMigrationFile {
  path: string
  backupPath: string
  id: string
  status: IdMigrationFileStatus
}

export interface IdMigrationRecovery {
  journalPath: string
  backupPath: string
  status: IdMigrationStatus
  files: IdMigrationFile[]
}

export interface PathChange {
  oldPath: string
  newPath: string
}

export interface FsMutationResult {
  primaryId?: string | null
  primaryPath?: string | null
  pathChanges: PathChange[]
  deletedPaths: string[]
  deletedIds?: string[]
}

type IndexState = "healthy" | "degraded" | "rebuildRequired"
type OperationWarning = "indexRebuildRequired"

export interface MutationOutcome {
  mutation: FsMutationResult
  indexState: IndexState
  warnings: OperationWarning[]
}

export interface WriteNoteOutcome {
  path: string
  indexState: IndexState
  warnings: OperationWarning[]
}

export type LayerKind = "canvas" | "database" | "sketch"

export interface LayerResult {
  notePath: string
  layerPath: string
  kind: LayerKind
  pathChanges: PathChange[]
}

export interface NoteLayers {
  canvas: boolean
  sketch: boolean
  database: boolean
}

export interface LinkGraphNode {
  id: string
  label: string
  unresolved?: boolean
}

export interface LinkGraphEdge {
  source: string
  target: string
  label: string
  unresolved?: boolean
}

export interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

export interface VaultTagEntry {
  tag: string
  notes: IndexedNote[]
}

export interface ImportedAsset {
  relPath: string
  absPath: string
  fileName: string
  kind: "image" | "file"
}

export type SettingsReadResult<T> =
  | { status: "found"; data: T }
  | { status: "missing" }
  | { status: "corrupt"; raw: string; error: string }
  | { status: "unavailable"; error: string }

export interface CredentialInfo {
  exists: boolean
  masked: string | null
}

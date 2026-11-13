export interface TreeItem {
  id: string
  path: string
  name: string
  type: "folder" | "file" | "canvas" | "sketch" | "database"
  icon?: string
  /**
   * UI only, never stored: replaces the glyph at the right end of a folder's row. A module that
   * presents a folder as something else (a universe) sets it in its view of the tree.
   */
  statusIcon?: string
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
  /** The items when the value is a YAML list, as they are; the browser adapter leaves it out. */
  items?: string[]
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
  frontmatterStatus?: "none" | "valid" | "invalid" | "unterminated"
  bodyReadOnly?: boolean
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

export interface HistoryStats {
  snapshotCount: number
  noteCount: number
  sizeBytes: number
}

export interface HistoryRetention {
  maxSnapshotsPerNote: number
  maxAgeDays: number | null
}

export interface HistoryCleanupResult {
  removedCount: number
  freedBytes: number
  remaining: HistoryStats
}

export interface HistoryCleanupPreview {
  removedCount: number
  freedBytes: number
  remaining: HistoryStats
}

export interface RefactorPreview {
  notes: number
  replacements: number
}

/** A file of the hidden archive `.amby/archive/` (docs/sync-plan.md, К6). */
export type { ArchiveEntry } from "../bindings"

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

export interface SearchResult {
  note: IndexedNote
  matchType: "name" | "content" | "tag"
  snippet?: string
  score: number
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
  vaultPath: string
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
  /**
   * What the sidebar tree has to change after this mutation, built by the backend from the disk.
   * Absent when the change cannot be expressed as a patch: the caller reloads the tree.
   */
  treePatch?: TreePatch | null
}

/** One change of the tree; applied in order (see `applyTreePatchOps`). */
export type TreePatchOp =
  | {
      kind: "remove"
      /** The item holding the entry, `null` for the vault root. */
      parentPath: string | null
      /** Alternative paths of one entry: itself, or its main layer file. */
      paths: string[]
    }
  | {
      kind: "upsert"
      parentPath: string | null
      item: TreeItem
      /** Off: the item keeps the children it already has (only its own fields change). */
      replaceChildren: boolean
    }

export interface TreePatch {
  ops: TreePatchOp[]
}

/** The answer to a refresh of a few paths. */
export interface PathsRefresh {
  generation: number
  patch: TreePatch
  sync: SyncReport
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
  revision: string
  indexState: IndexState
  warnings: OperationWarning[]
}

export interface NoteReadOutcome {
  content: string
  revision: string
  source: string
}

/** A compare-and-swap rejected a stale renderer buffer. */
export class NoteRevisionConflictError extends Error {
  constructor(public readonly actualRevision: string) {
    super("Note changed before save")
    this.name = "NoteRevisionConflictError"
  }
}

/**
 * A compare-and-swap rejected a stale buffer of a non-note file (Canvas,
 * Excalidraw). Nothing was written; the file on disk changed after it was read.
 */
export class FileRevisionConflictError extends Error {
  constructor(public readonly actualRevision: string) {
    super("File changed before save")
    this.name = "FileRevisionConflictError"
  }
}

export type LayerKind = "canvas" | "database" | "sketch" | "note"

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
  note: boolean
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

/** The title and the description of a web page, as plain one-line text. */
export interface PageInfo {
  title: string
  description: string | null
}

export interface ImportedAsset {
  relPath: string
  absPath: string
  fileName: string
  kind: "image" | "file"
}

/** What a drop of files from the system onto the tree brought in, and what it left out. */
export interface ImportFilesResult {
  /** Absolute paths of the copies (a folder counts once). */
  imported: string[]
  skipped: Array<{
    name: string
    reason: "hidden" | "too_large" | "unreadable" | "link" | "into_itself" | "too_many"
  }>
}

/** Where deleting an item sends it; `permanent` keeps no copy at all. */
export type DeleteMode = "system" | "archive" | "permanent"

export type SettingsReadResult<T> =
  | { status: "found"; data: T }
  | { status: "missing" }
  | { status: "corrupt"; raw: string; error: string }
  | { status: "unavailable"; error: string }

export interface CredentialInfo {
  exists: boolean
  masked: string | null
}

export type { TrashPreview } from "../bindings"

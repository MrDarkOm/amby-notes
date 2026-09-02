import { DesktopAdapter } from "./desktop-adapter"
import { WebAdapter } from "./web-adapter"
import { NotesRepository } from "./notes-repository"
import { MutationsRepository } from "./mutations-repository"
import { AssetsRepository } from "./assets-repository"
import { HistoryRepository } from "./history-repository"
import { SettingsRepository } from "./settings-repository"
import type { StoragePort } from "./port"
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
  NoteReadOutcome,
  NoteLayers,
  NoteProperties,
  RefactorPreview,
  SearchResult,
  SettingsReadResult,
  SnapshotEntry,
  SnapshotText,
  TrashEntry,
  VaultPreflight,
  VaultTagEntry,
  WriteNoteOutcome,
} from "./types"

export * from "./types"
export * from "./port"
export * from "./desktop-adapter"
export * from "./web-adapter"
export * from "./notes-repository"
export * from "./mutations-repository"
export * from "./assets-repository"
export * from "./history-repository"
export * from "./settings-repository"

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

let adapterInstance: StoragePort | null = null

function getStorageAdapter(): StoragePort {
  if (!adapterInstance) {
    adapterInstance = isTauri() ? new DesktopAdapter() : new WebAdapter()
  }
  return adapterInstance
}

export function setStorageAdapter(adapter: StoragePort | null): void {
  adapterInstance = adapter
}

const getAdapter = () => getStorageAdapter()

export const notesRepository = new NotesRepository(getAdapter)
export const mutationsRepository = new MutationsRepository(getAdapter)
const assetsRepository = new AssetsRepository(getAdapter)
const historyRepository = new HistoryRepository(getAdapter)
export const settingsRepository = new SettingsRepository(getAdapter)

// ── Public Facade Functions ─────────────────────────────────────────────────

// Vault & Notes
export const openVault = (): Promise<string | null> => notesRepository.openVault()
export const startVaultWatcher = (vaultPath: string): Promise<void> =>
  notesRepository.startVaultWatcher(vaultPath)
export const stopVaultWatcher = (): Promise<void> => notesRepository.stopVaultWatcher()
export const loadVaultData = (vaultPath: string): Promise<LoadVaultResult> =>
  notesRepository.loadVaultData(vaultPath)
export const loadActiveVaultData = (): Promise<LoadVaultResult> =>
  notesRepository.loadActiveVaultData()
export const preflightVault = (vaultPath: string): Promise<VaultPreflight> =>
  notesRepository.preflightVault(vaultPath)
export const applyIdMigration = (vaultPath: string): Promise<void> =>
  notesRepository.applyIdMigration(vaultPath)
export const recoverIdMigration = (
  vaultPath: string,
  journalPath: string,
  action: IdMigrationRecoveryAction,
): Promise<IdMigrationRecovery> =>
  notesRepository.recoverIdMigration(vaultPath, journalPath, action)
export const readFile = (path: string): Promise<string> => notesRepository.readFile(path)
export const searchNotes = (query: string): Promise<SearchResult[]> =>
  notesRepository.searchNotes(query)
export const readNote = (vaultPath: string, noteId: string): Promise<NoteReadOutcome> =>
  notesRepository.readNote(vaultPath, noteId)
export const writeFile = (path: string, content: string): Promise<void> =>
  notesRepository.writeFile(path, content)
export const writeNote = (
  vaultPath: string,
  noteId: string,
  content: string,
  expectedGeneration: number | null,
  expectedRevision: string,
  originWindow: string,
): Promise<WriteNoteOutcome> =>
  notesRepository.writeNote(
    vaultPath,
    noteId,
    content,
    expectedGeneration,
    expectedRevision,
    originWindow,
  )
export const restoreDeletedNote = (
  vaultPath: string,
  noteId: string,
  path: string,
  content: string,
  sourceTemplate: string,
  expectedGeneration: number | null,
  originWindow: string,
): Promise<WriteNoteOutcome> =>
  notesRepository.restoreDeletedNote(
    vaultPath,
    noteId,
    path,
    content,
    sourceTemplate,
    expectedGeneration,
    originWindow,
  )
export const saveConflictCopy = (path: string, content: string): Promise<string> =>
  notesRepository.saveConflictCopy(path, content)
export const createNote = (
  vaultPath: string,
  parentPath: string,
  name: string,
): Promise<FsMutationResult> => notesRepository.createNote(vaultPath, parentPath, name)
export const getNoteMetadata = (vaultPath: string, noteId: string): Promise<FileMetadata> =>
  notesRepository.getNoteMetadata(vaultPath, noteId)
export const getNoteProperties = (vaultPath: string, noteId: string): Promise<NoteProperties> =>
  notesRepository.getNoteProperties(vaultPath, noteId)
export const upsertCustomProperty = (
  vaultPath: string,
  noteId: string,
  property: CustomProperty,
): Promise<CustomProperty> => notesRepository.upsertCustomProperty(vaultPath, noteId, property)
export const deleteCustomProperty = (
  vaultPath: string,
  noteId: string,
  propertyId: string,
): Promise<void> => notesRepository.deleteCustomProperty(vaultPath, noteId, propertyId)
export const getLinkGraph = (vaultPath: string): Promise<LinkGraph> =>
  notesRepository.getLinkGraph(vaultPath)
export const listTags = (vaultPath: string): Promise<VaultTagEntry[]> =>
  notesRepository.listTags(vaultPath)

// Mutations & Canvas / Layers
export const createFolder = (vaultPath: string, name: string): Promise<string> =>
  mutationsRepository.createFolder(vaultPath, name)
export const createCanvasFile = (
  vaultPath: string,
  parentPath: string | null,
  name: string,
): Promise<string> => mutationsRepository.createCanvasFile(vaultPath, parentPath, name)
export const attachCanvasToNote = (
  vaultPath: string,
  canvasPath: string,
): Promise<FsMutationResult> => mutationsRepository.attachCanvasToNote(vaultPath, canvasPath)
export const renameItem = (
  vaultPath: string,
  path: string,
  newName: string,
): Promise<FsMutationResult> => mutationsRepository.renameItem(vaultPath, path, newName)
export const moveItem = (
  vaultPath: string,
  sourcePath: string,
  targetPath: string,
): Promise<FsMutationResult> => mutationsRepository.moveItem(vaultPath, sourcePath, targetPath)
export const deleteItem = (vaultPath: string, path: string): Promise<FsMutationResult> =>
  mutationsRepository.deleteItem(vaultPath, path)
export const noteLayers = (notePath: string): Promise<NoteLayers> =>
  mutationsRepository.noteLayers(notePath)
export const createLayer = (notePath: string, kind: LayerKind): Promise<LayerResult> =>
  mutationsRepository.createLayer(notePath, kind)
export const unlinkLayer = (
  vaultPath: string,
  notePath: string,
  kind: LayerKind,
): Promise<FsMutationResult> => mutationsRepository.unlinkLayer(vaultPath, notePath, kind)
export const deleteLayer = (
  vaultPath: string,
  notePath: string,
  kind: LayerKind,
): Promise<FsMutationResult> => mutationsRepository.deleteLayer(vaultPath, notePath, kind)

// History, Trash & Refactoring
export const listSnapshots = (sourcePath: string): Promise<SnapshotEntry[]> =>
  historyRepository.listSnapshots(sourcePath)
export const getHistoryStats = (): Promise<HistoryStats> => historyRepository.getHistoryStats()
export const previewHistoryCleanup = (
  retention: HistoryRetention,
  sourcePath?: string,
): Promise<HistoryCleanupPreview> => historyRepository.previewHistoryCleanup(retention, sourcePath)
export const cleanupHistory = (
  retention: HistoryRetention,
  sourcePath?: string,
): Promise<HistoryCleanupResult> => historyRepository.cleanupHistory(retention, sourcePath)
export const restoreSnapshot = (snapshotId: string): Promise<string> =>
  historyRepository.restoreSnapshot(snapshotId)
export const deleteSnapshot = (snapshotId: string): Promise<void> =>
  historyRepository.deleteSnapshot(snapshotId)
export const readSnapshotText = (snapshotId: string): Promise<SnapshotText> =>
  historyRepository.readSnapshotText(snapshotId)
export const listTrash = (): Promise<TrashEntry[]> => historyRepository.listTrash()
export const restoreTrash = (trashId: string): Promise<FsMutationResult> =>
  historyRepository.restoreTrash(trashId)
export const purgeTrash = (trashId: string): Promise<void> => historyRepository.purgeTrash(trashId)
export const previewRenameRefactor = (
  vaultPath: string,
  path: string,
  newName: string,
): Promise<RefactorPreview> => historyRepository.previewRenameRefactor(vaultPath, path, newName)
export const previewMoveRefactor = (
  vaultPath: string,
  sourcePath: string,
  targetPath: string,
): Promise<RefactorPreview> =>
  historyRepository.previewMoveRefactor(vaultPath, sourcePath, targetPath)

// Assets, Dialogs & System
export const openInExplorer = (path: string): Promise<void> => assetsRepository.openInExplorer(path)
export const pickAssetFile = (imagesOnly: boolean): Promise<string | null> =>
  assetsRepository.pickAssetFile(imagesOnly)
export const importAsset = (
  vaultPath: string,
  notePath: string,
  sourcePath: string,
): Promise<ImportedAsset | null> => assetsRepository.importAsset(vaultPath, notePath, sourcePath)
export const importAssetBytes = (
  vaultPath: string,
  notePath: string,
  bytes: Uint8Array,
  suggestedExt: string,
): Promise<ImportedAsset | null> =>
  assetsRepository.importAssetBytes(vaultPath, notePath, bytes, suggestedExt)
export const toAssetUrl = (absPath: string): Promise<string> => assetsRepository.toAssetUrl(absPath)
export const exportTextFile = (contents: string, defaultName: string): Promise<string | null> =>
  assetsRepository.exportTextFile(contents, defaultName)
export const importTextFile = (): Promise<string | null> => assetsRepository.importTextFile()
export const confirmAction = (message: string): Promise<boolean> =>
  assetsRepository.confirmAction(message)
export const showErrorMessage = (message: string): Promise<void> =>
  assetsRepository.showErrorMessage(message)

// Settings, Vault Metadata & AI Credentials
export const readGlobalSettingsResult = <T>(file: string): Promise<SettingsReadResult<T>> =>
  settingsRepository.readGlobalSettingsResult<T>(file)
export const loadGlobalJSON = <T>(file: string, fallback: T): Promise<T> =>
  settingsRepository.loadGlobalJSON<T>(file, fallback)
export const saveGlobalJSON = (file: string, data: unknown): Promise<void> =>
  settingsRepository.saveGlobalJSON(file, data)
export const loadVaultJSON = <T>(rel: string, fallback: T): Promise<T> =>
  settingsRepository.loadVaultJSON<T>(rel, fallback)
export const saveVaultJSON = (rel: string, data: unknown): Promise<void> =>
  settingsRepository.saveVaultJSON(rel, data)
export const globalFileMissing = (file: string): Promise<boolean> =>
  settingsRepository.globalFileMissing(file)
export const vaultFileMissing = (rel: string): Promise<boolean> =>
  settingsRepository.vaultFileMissing(rel)
export const storeAiCredential = (credentialId: string, secret: string): Promise<void> =>
  settingsRepository.storeAiCredential(credentialId, secret)
export const deleteAiCredential = (credentialId: string): Promise<void> =>
  settingsRepository.deleteAiCredential(credentialId)
export const inspectAiCredential = (credentialId: string): Promise<CredentialInfo> =>
  settingsRepository.inspectAiCredential(credentialId)

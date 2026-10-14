import { DesktopAdapter } from "./desktop-adapter"
import { WebAdapter } from "./web-adapter"
import { NotesRepository } from "./notes-repository"
import { MutationsRepository } from "./mutations-repository"
import { AssetsRepository } from "./assets-repository"
import { HistoryRepository } from "./history-repository"
import { SettingsRepository } from "./settings-repository"
import { configureDebugRepositoryRuntime } from "./debug-repository"
import { logger, traceOperation } from "../logger"
import type { StoragePort, WriteNoteOptions } from "./port"
import type {
  CreateDatabaseRequest,
  CreateDatabasePropertyRequest,
  ChangeDatabasePropertyTypeRequest,
  DeleteDatabasePropertyRequest,
  ReorderDatabasePropertiesRequest,
  RenameDatabasePropertyRequest,
  UpdateDatabasePropertyOptionsRequest,
  UpdateDatabasePropertyConfigRequest,
  RenameDatabaseRequest,
  DatabaseQueryRequest,
  DatabaseValueBatchRequest,
  CreateDatabaseRowRequest,
  DuplicateDatabaseRowRequest,
  ImportDatabaseAssetRequest,
  ConfigureDatabaseRollupRequest,
  ResolveDatabaseAssetPathsRequest,
  SearchRelationCandidatesRequest,
  ResolveRecordReferencesRequest,
  DatabaseYamlSyncRequest,
  DatabaseYamlResolveRequest,
  CreateDatabaseViewRequest,
  DatabaseViewRequest,
  RenameDatabaseViewRequest,
  UpdateDatabaseViewConfigRequest,
  DeleteDatabaseViewRequest,
  ReorderDatabaseViewsRequest,
  DatabaseAggregateRequest,
  DatabaseChangedPayload,
  UpdateDatabaseRelationValueRequest,
} from "./database-types"
import type {
  AddStoryLinksRequest,
  AddTextStatusRequest,
  CreateStoryRequest,
  CreateWorkshopEntityRequest,
  CreateWorkshopRequest,
  CreateWorkshopSectionRequest,
  CreateTextPageRequest,
  MoveTextPageRequest,
  RemoveWorkshopSectionRequest,
  ReorderWorkshopSectionsRequest,
  UpdateWorkshopRequest,
  UpdateTextLevelsRequest,
} from "./project-types"
import type {
  CredentialInfo,
  CustomProperty,
  FileMetadata,
  FsMutationResult,
  DeleteMode,
  HistoryCleanupPreview,
  HistoryCleanupResult,
  HistoryRetention,
  HistoryStats,
  IdMigrationRecovery,
  IdMigrationRecoveryAction,
  ImportedAsset,
  PageInfo,
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
export * from "./database-port"
export * from "./database-types"
export * from "./project-port"
export * from "./project-types"
export * from "./desktop-adapter"
export * from "./web-adapter"
export * from "./notes-repository"
export * from "./mutations-repository"
export * from "./assets-repository"
export * from "./history-repository"
export * from "./settings-repository"
export * from "./debug-repository"

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

configureDebugRepositoryRuntime({ isNative: isTauri })

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
  traceOperation("watcher.start", {}, () => notesRepository.startVaultWatcher(vaultPath))
export const stopVaultWatcher = (): Promise<void> =>
  traceOperation("watcher.stop", {}, () => notesRepository.stopVaultWatcher())
export const loadVaultData = (vaultPath: string): Promise<LoadVaultResult> =>
  traceOperation("index.load", {}, () => notesRepository.loadVaultData(vaultPath))
export const loadActiveVaultData = (): Promise<LoadVaultResult> =>
  traceOperation("index.refresh", {}, () => notesRepository.loadActiveVaultData())
export const reindexActiveVaultData = (): Promise<LoadVaultResult> =>
  traceOperation("index.rebuild", {}, () => notesRepository.reindexActiveVaultData())
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
export const readFile = (path: string): Promise<string> =>
  traceOperation("storage.read_file", {}, () => notesRepository.readFile(path))
export const searchNotes = (query: string): Promise<SearchResult[]> =>
  traceOperation("search.notes", {}, () => notesRepository.searchNotes(query))
export const readNote = (vaultPath: string, noteId: string): Promise<NoteReadOutcome> => {
  return traceOperation("storage.read_note", { noteId }, (operationId) =>
    notesRepository.readNote(vaultPath, noteId, operationId),
  )
}
export const writeFile = (
  path: string,
  content: string,
  operationId?: string,
  expectedRevision?: string,
): Promise<string> =>
  traceOperation(
    "storage.write_file",
    {},
    () => notesRepository.writeFile(path, content, expectedRevision),
    { operationId },
  )
export const getFileRevision = (path: string): Promise<string> =>
  notesRepository.getFileRevision(path)
export const writeNote = (
  vaultPath: string,
  noteId: string,
  content: string,
  expectedGeneration: number | null,
  expectedRevision: string,
  originWindow: string,
  operationId?: string,
  options?: WriteNoteOptions,
): Promise<WriteNoteOutcome> => {
  return traceOperation(
    "storage.write_note",
    { noteId },
    (id) =>
      notesRepository.writeNote(
        vaultPath,
        noteId,
        content,
        expectedGeneration,
        expectedRevision,
        originWindow,
        id,
        options,
      ),
    { operationId },
  )
}
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
): Promise<FsMutationResult> => {
  logger.info("storage.create_note", { parentPath, name })
  return notesRepository.createNote(vaultPath, parentPath, name)
}
export const getNoteMetadata = (vaultPath: string, noteId: string): Promise<FileMetadata> =>
  notesRepository.getNoteMetadata(vaultPath, noteId)
export const getNoteProperties = (vaultPath: string, noteId: string): Promise<NoteProperties> =>
  notesRepository.getNoteProperties(vaultPath, noteId)
export const upsertCustomProperty = (
  vaultPath: string,
  noteId: string,
  property: CustomProperty,
): Promise<CustomProperty> => {
  logger.info("storage.upsert_custom_property", {
    noteId,
    propertyId: property.id,
    name: property.name,
    propertyType: property.propertyType,
  })
  return notesRepository.upsertCustomProperty(vaultPath, noteId, property)
}
export const deleteCustomProperty = (
  vaultPath: string,
  noteId: string,
  propertyId: string,
): Promise<void> => {
  logger.info("storage.delete_custom_property", { noteId, propertyId })
  return notesRepository.deleteCustomProperty(vaultPath, noteId, propertyId)
}
export const reorderCustomProperties = (
  vaultPath: string,
  noteId: string,
  propertyIds: string[],
): Promise<void> => {
  logger.info("storage.reorder_custom_properties", { noteId, count: propertyIds.length })
  return notesRepository.reorderCustomProperties(vaultPath, noteId, propertyIds)
}
export const backupCustomProperties = (vaultPath: string, noteId: string): Promise<string> =>
  notesRepository.backupCustomProperties(vaultPath, noteId)
export const getLinkGraph = (vaultPath: string): Promise<LinkGraph> =>
  notesRepository.getLinkGraph(vaultPath)
export const listTags = (vaultPath: string): Promise<VaultTagEntry[]> =>
  notesRepository.listTags(vaultPath)

// Database runtime skeleton (DB-02). Discovery and durable files begin in DB-03/04.
export const getDatabaseModuleState = () => getAdapter().getDatabaseModuleState()
export const setDatabaseModuleEnabled = (enabled: boolean, expectedGeneration: number) =>
  getAdapter().setDatabaseModuleEnabled(enabled, expectedGeneration)
export const rebuildDatabaseProjection = () =>
  traceOperation("database.rebuild", {}, () => getAdapter().rebuildDatabaseProjection())
export const refreshDatabaseChange = (change: DatabaseChangedPayload) =>
  traceOperation("database.refresh", {}, () => getAdapter().refreshDatabaseChange(change))
export const createDatabase = (request: CreateDatabaseRequest) => {
  logger.info("storage.create_database", {
    name: request.name,
    parentPath: request.parentPath,
    mode: request.mode,
  })
  return getAdapter().createDatabase(request)
}
export const createDatabaseProperty = (request: CreateDatabasePropertyRequest) => {
  logger.info("storage.create_database_property", {
    databaseId: request.databaseId,
    name: request.name,
    propertyType: request.propertyType,
  })
  return getAdapter().createDatabaseProperty(request)
}
export const changeDatabasePropertyType = (request: ChangeDatabasePropertyTypeRequest) => {
  logger.info("storage.change_database_property_type", {
    databaseId: request.databaseId,
    propertyId: request.propertyId,
    propertyType: request.propertyType,
  })
  return getAdapter().changeDatabasePropertyType(request)
}
export const deleteDatabaseProperty = (request: DeleteDatabasePropertyRequest) => {
  logger.info("storage.delete_database_property", {
    databaseId: request.databaseId,
    propertyId: request.propertyId,
  })
  return getAdapter().deleteDatabaseProperty(request)
}
export const renameDatabaseProperty = (request: RenameDatabasePropertyRequest) => {
  logger.info("storage.rename_database_property", {
    databaseId: request.databaseId,
    propertyId: request.propertyId,
    name: request.name,
  })
  return getAdapter().renameDatabaseProperty(request)
}
export const updateDatabasePropertyConfig = (request: UpdateDatabasePropertyConfigRequest) => {
  logger.info("storage.update_database_property_config", {
    databaseId: request.databaseId,
    propertyId: request.propertyId,
  })
  return getAdapter().updateDatabasePropertyConfig(request)
}
export const updateDatabasePropertyOptions = (request: UpdateDatabasePropertyOptionsRequest) => {
  logger.info("storage.update_database_property_options", {
    databaseId: request.databaseId,
    propertyId: request.propertyId,
    optionCount: request.options.length,
  })
  return getAdapter().updateDatabasePropertyOptions(request)
}
export const renameDatabase = (request: RenameDatabaseRequest) =>
  getAdapter().renameDatabase(request)
export const applyDatabaseValueBatch = (request: DatabaseValueBatchRequest) => {
  logger.info("storage.apply_database_value_batch", {
    databaseId: request.databaseId,
    updatesCount: request.cells.length,
  })
  return traceOperation(
    "database.write_batch",
    { databaseId: request.databaseId, count: request.cells.length },
    () => getAdapter().applyDatabaseValueBatch(request),
    { operationId: request.operationId },
  )
}
export const updateDatabaseRelationValue = (request: UpdateDatabaseRelationValueRequest) => {
  logger.info("storage.update_database_relation_value", {
    databaseId: request.databaseId,
    noteId: request.noteId,
  })
  return getAdapter().updateDatabaseRelationValue(request)
}
export const createDatabaseRow = (request: CreateDatabaseRowRequest) => {
  logger.info("storage.create_database_row", {
    databaseId: request.databaseId,
    title: request.title,
  })
  return getAdapter().createDatabaseRow(request)
}
export const duplicateDatabaseRow = (request: DuplicateDatabaseRowRequest) => {
  logger.info("storage.duplicate_database_row", {
    databaseId: request.databaseId,
    noteId: request.noteId,
  })
  return getAdapter().duplicateDatabaseRow(request)
}
export const importDatabaseAsset = (request: ImportDatabaseAssetRequest) =>
  getAdapter().importDatabaseAsset(request)
export const resolveDatabaseAssetPaths = (request: ResolveDatabaseAssetPathsRequest) =>
  getAdapter().resolveDatabaseAssetPaths(request)
export const searchRelationCandidates = (request: SearchRelationCandidatesRequest) =>
  getAdapter().searchRelationCandidates(request)
export const resolveRecordReferences = (request: ResolveRecordReferencesRequest) =>
  getAdapter().resolveRecordReferences(request)
export const configureDatabaseRollup = (request: ConfigureDatabaseRollupRequest) =>
  getAdapter().configureDatabaseRollup(request)
export const syncDatabaseYaml = (request: DatabaseYamlSyncRequest) =>
  traceOperation("database.sync_yaml", { databaseId: request.databaseId }, () =>
    getAdapter().syncDatabaseYaml(request),
  )
export const resolveDatabaseYamlConflict = (request: DatabaseYamlResolveRequest) =>
  getAdapter().resolveDatabaseYamlConflict(request)
export const listProjects = () => getAdapter().listProjects()
export const refreshProjects = (expectedGeneration: number) =>
  traceOperation("project.refresh", {}, () => getAdapter().refreshProjects(expectedGeneration))
export const createWorkshop = (request: CreateWorkshopRequest) => {
  logger.info("storage.create_workshop", {
    name: request.name,
    parentPath: request.parentPath ?? null,
    operationId: request.operationId,
  })
  return getAdapter().createWorkshop(request)
}
export const createStory = (request: CreateStoryRequest) => {
  logger.info("storage.create_story", {
    workshopId: request.workshopId,
    title: request.title,
    operationId: request.operationId,
  })
  return getAdapter().createStory(request)
}
export const createWorkshopSection = (request: CreateWorkshopSectionRequest) => {
  logger.info("storage.create_workshop_section", {
    workshopId: request.workshopId,
    name: request.name,
    role: request.role,
    operationId: request.operationId,
  })
  return getAdapter().createWorkshopSection(request)
}
export const updateWorkshop = (request: UpdateWorkshopRequest) => {
  logger.info("storage.update_workshop", {
    workshopId: request.workshopId,
    operationId: request.operationId,
  })
  return getAdapter().updateWorkshop(request)
}
export const removeWorkshopSection = (request: RemoveWorkshopSectionRequest) => {
  logger.info("storage.remove_workshop_section", {
    workshopId: request.workshopId,
    sectionId: request.sectionId,
    operationId: request.operationId,
  })
  return getAdapter().removeWorkshopSection(request)
}
export const reorderWorkshopSections = (request: ReorderWorkshopSectionsRequest) => {
  logger.info("storage.reorder_workshop_sections", {
    workshopId: request.workshopId,
    count: request.sectionIds.length,
    operationId: request.operationId,
  })
  return getAdapter().reorderWorkshopSections(request)
}
export const updateTextLevels = (request: UpdateTextLevelsRequest) => {
  logger.info("storage.update_text_levels", {
    storyId: request.storyId,
    count: request.levels.length,
    operationId: request.operationId,
  })
  return getAdapter().updateTextLevels(request)
}
export const addTextStatus = (request: AddTextStatusRequest) => {
  logger.info("storage.add_text_status", {
    storyId: request.storyId,
    operationId: request.operationId,
  })
  return getAdapter().addTextStatus(request)
}
export const addStoryLinks = (request: AddStoryLinksRequest) => {
  logger.info("storage.add_story_links", {
    sectionId: request.sectionId,
    operationId: request.operationId,
  })
  return getAdapter().addStoryLinks(request)
}
export const createWorkshopEntity = (request: CreateWorkshopEntityRequest) => {
  logger.info("storage.create_workshop_entity", {
    sectionId: request.sectionId,
    linked: request.storyId != null,
    notebook: (request.notebook?.length ?? 0) > 0,
  })
  return getAdapter().createWorkshopEntity(request)
}
export const createTextPage = (request: CreateTextPageRequest) => {
  logger.info("storage.create_text_page", {
    storyId: request.storyId,
    levelId: request.levelId,
    hasParent: Boolean(request.parentNoteId),
  })
  return getAdapter().createTextPage(request)
}
export const moveTextPage = (request: MoveTextPageRequest) => {
  logger.info("storage.move_text_page", {
    storyId: request.storyId,
    noteId: request.noteId,
    operationId: request.operationId,
  })
  return getAdapter().moveTextPage(request)
}
export const listNoteReferences = (noteId: string) => getAdapter().listNoteReferences(noteId)
export const listTextStats = (databaseId: string) => getAdapter().listTextStats(databaseId)
export const listNotebooks = (databaseId: string) => getAdapter().listNotebooks(databaseId)
export const listDatabases = () => getAdapter().listDatabases()
export const getDatabaseNoteContext = (noteId: string) =>
  getAdapter().getDatabaseNoteContext(noteId)
export const reorderDatabaseProperties = (request: ReorderDatabasePropertiesRequest) => {
  logger.info("storage.reorder_database_properties", {
    databaseId: request.databaseId,
    count: request.propertyIds.length,
  })
  return getAdapter().reorderDatabaseProperties(request)
}
export const queryDatabase = (request: DatabaseQueryRequest) =>
  traceOperation("database.query", { databaseId: request.databaseId }, () =>
    getAdapter().queryDatabase(request),
  )
export const getDatabaseView = (request: DatabaseViewRequest) =>
  getAdapter().getDatabaseView(request)
export const createDatabaseView = (request: CreateDatabaseViewRequest) => {
  logger.info("storage.create_database_view", {
    databaseId: request.databaseId,
    name: request.name,
  })
  return getAdapter().createDatabaseView(request)
}
export const renameDatabaseView = (request: RenameDatabaseViewRequest) => {
  logger.info("storage.rename_database_view", {
    databaseId: request.databaseId,
    viewId: request.viewId,
    name: request.name,
  })
  return getAdapter().renameDatabaseView(request)
}
export const updateDatabaseViewConfig = (request: UpdateDatabaseViewConfigRequest) =>
  getAdapter().updateDatabaseViewConfig(request)
export const duplicateDatabaseView = (request: DatabaseViewRequest) =>
  getAdapter().duplicateDatabaseView(request)
export const deleteDatabaseView = (request: DeleteDatabaseViewRequest) => {
  logger.info("storage.delete_database_view", {
    databaseId: request.databaseId,
    viewId: request.viewId,
  })
  return getAdapter().deleteDatabaseView(request)
}
export const reorderDatabaseViews = (request: ReorderDatabaseViewsRequest) =>
  getAdapter().reorderDatabaseViews(request)
export const setDefaultDatabaseView = (request: DatabaseViewRequest) =>
  getAdapter().setDefaultDatabaseView(request)
export const aggregateDatabase = (request: DatabaseAggregateRequest) =>
  traceOperation("database.aggregate", { databaseId: request.databaseId }, () =>
    getAdapter().aggregateDatabase(request),
  )
export const undoDatabaseMutation = (databaseId: string) =>
  getAdapter().undoDatabaseMutation(databaseId)
export const redoDatabaseMutation = (databaseId: string) =>
  getAdapter().redoDatabaseMutation(databaseId)
export const getDatabaseHistoryStatus = (databaseId: string) =>
  getAdapter().getDatabaseHistoryStatus(databaseId)

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
export const createSketchFile = (
  vaultPath: string,
  parentPath: string | null,
  name: string,
): Promise<string> => mutationsRepository.createSketchFile(vaultPath, parentPath, name)
export const attachSketchToNote = (
  vaultPath: string,
  sketchPath: string,
): Promise<FsMutationResult> => mutationsRepository.attachSketchToNote(vaultPath, sketchPath)
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
export const deleteItem = (
  vaultPath: string,
  path: string,
  mode?: DeleteMode,
): Promise<FsMutationResult> => mutationsRepository.deleteItem(vaultPath, path, mode)
export const archiveItem = (vaultPath: string, path: string): Promise<FsMutationResult> =>
  mutationsRepository.archiveItem(vaultPath, path)
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
export const openAttachment = (notePath: string, attachmentPath: string): Promise<void> =>
  assetsRepository.openAttachment(notePath, attachmentPath)
export const openWebAddress = (address: string): Promise<void> =>
  assetsRepository.openWebAddress(address)
export const fetchPageInfo = (address: string): Promise<PageInfo> =>
  assetsRepository.fetchPageInfo(address)
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

export { joinStoragePath } from "./storage-path"

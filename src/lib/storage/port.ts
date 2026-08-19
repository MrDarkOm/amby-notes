import type {
  CredentialInfo,
  CustomProperty,
  FileMetadata,
  FsMutationResult,
  IdMigrationRecovery,
  IdMigrationRecoveryAction,
  ImportedAsset,
  LayerKind,
  LayerResult,
  LinkGraph,
  LoadVaultResult,
  NoteLayers,
  NoteProperties,
  RefactorPreview,
  SnapshotEntry,
  SnapshotText,
  TrashEntry,
  TreeItem,
  VaultPreflight,
  VaultTagEntry,
} from "./types"

export interface StoragePort {
  // Vault Lifecycle & Index
  openVault(): Promise<string | null>
  startVaultWatcher(vaultPath: string): Promise<void>
  stopVaultWatcher(): Promise<void>
  loadVaultData(vaultPath: string): Promise<LoadVaultResult>
  loadActiveVaultData(): Promise<LoadVaultResult>
  preflightVault(vaultPath: string): Promise<VaultPreflight>
  applyIdMigration(vaultPath: string): Promise<void>
  inspectIdMigrations(vaultPath: string): Promise<IdMigrationRecovery[]>
  recoverIdMigration(
    vaultPath: string,
    journalPath: string,
    action: IdMigrationRecoveryAction,
  ): Promise<IdMigrationRecovery>
  listFiles(vaultPath: string): Promise<TreeItem[]>

  // Notes & Text Files
  readFile(path: string): Promise<string>
  readNote(vaultPath: string, noteId: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  writeNote(
    vaultPath: string,
    noteId: string,
    content: string,
    expectedGeneration: number | null,
  ): Promise<void>
  saveConflictCopy(path: string, content: string): Promise<string>
  createNote(vaultPath: string, parentPath: string, name: string): Promise<FsMutationResult>
  createFolder(vaultPath: string, name: string): Promise<string>
  createCanvasFile(vaultPath: string, parentPath: string | null, name: string): Promise<string>
  attachCanvasToNote(vaultPath: string, canvasPath: string): Promise<FsMutationResult>
  renameItem(vaultPath: string, path: string, newName: string): Promise<FsMutationResult>
  moveItem(vaultPath: string, sourcePath: string, targetPath: string): Promise<FsMutationResult>
  deleteItem(vaultPath: string, path: string): Promise<FsMutationResult>

  // Layers
  noteLayers(notePath: string): Promise<NoteLayers>
  createLayer(notePath: string, kind: LayerKind): Promise<LayerResult>
  unlinkLayer(vaultPath: string, notePath: string, kind: LayerKind): Promise<FsMutationResult>
  deleteLayer(vaultPath: string, notePath: string, kind: LayerKind): Promise<FsMutationResult>

  // Metadata & Properties
  getNoteMetadata(vaultPath: string, noteId: string): Promise<FileMetadata>
  getFileMetadata(path: string): Promise<FileMetadata>
  getNoteProperties(vaultPath: string, noteId: string): Promise<NoteProperties>
  upsertCustomProperty(
    vaultPath: string,
    noteId: string,
    property: CustomProperty,
  ): Promise<CustomProperty>
  deleteCustomProperty(vaultPath: string, noteId: string, propertyId: string): Promise<void>
  getLinkGraph(vaultPath: string): Promise<LinkGraph>
  listTags(vaultPath: string): Promise<VaultTagEntry[]>

  // History & Trash
  listSnapshots(sourcePath: string): Promise<SnapshotEntry[]>
  restoreSnapshot(snapshotId: string): Promise<string>
  readSnapshotText(snapshotId: string): Promise<SnapshotText>
  listTrash(): Promise<TrashEntry[]>
  restoreTrash(trashId: string): Promise<FsMutationResult>
  previewRenameRefactor(vaultPath: string, path: string, newName: string): Promise<RefactorPreview>
  previewMoveRefactor(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<RefactorPreview>

  // System & Assets
  openInExplorer(path: string): Promise<void>
  pickAssetFile(imagesOnly: boolean): Promise<string | null>
  importAsset(
    vaultPath: string,
    notePath: string,
    sourcePath: string,
  ): Promise<ImportedAsset | null>
  importAssetBytes(
    vaultPath: string,
    notePath: string,
    bytes: Uint8Array,
    suggestedExt: string,
  ): Promise<ImportedAsset | null>
  toAssetUrl(absPath: string): Promise<string>
  exportTextFile(contents: string, defaultName: string): Promise<string | null>
  importTextFile(): Promise<string | null>
  confirmAction(message: string): Promise<boolean>
  showErrorMessage(message: string): Promise<void>

  // Tiered Settings & App Data
  readGlobalRaw(file: string): Promise<string | null>
  writeGlobalRaw(file: string, contents: string): Promise<void>
  readVaultRaw(rel: string): Promise<string | null>
  writeVaultRaw(rel: string, contents: string): Promise<void>
  deleteVaultMeta(rel: string): Promise<void>

  // AI Credentials
  storeAiCredential(credentialId: string, secret: string): Promise<void>
  deleteAiCredential(credentialId: string): Promise<void>
  inspectAiCredential(credentialId: string): Promise<CredentialInfo>
}

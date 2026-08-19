import i18n from "@/lib/i18n"
import { commands } from "@/lib/bindings"
import { unwrapCommand } from "./ipc-result"
import type { StoragePort } from "./port"
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
  MutationOutcome,
  NoteLayers,
  NoteProperties,
  RefactorPreview,
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

export class DesktopAdapter implements StoragePort {
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

  async readFile(path: string): Promise<string> {
    return unwrapCommand(commands.readFile(path))
  }

  async readNote(_vaultPath: string, noteId: string): Promise<string> {
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
  ): Promise<void> {
    if (expectedGeneration === null) throw new Error("No active vault generation")
    const outcome = await unwrapCommand<WriteNoteOutcome>(
      commands.writeNote(expectedGeneration, noteId, content),
    )
    reportIndexOutcome(outcome)
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
    const path = _vaultPath ? `${_vaultPath.replace(/\/$/u, "")}/${name}` : name
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

  async getLinkGraph(_vaultPath: string): Promise<LinkGraph> {
    return unwrapCommand(commands.getLinkGraph())
  }

  async listTags(_vaultPath: string): Promise<VaultTagEntry[]> {
    return unwrapCommand(commands.listTags())
  }

  async listSnapshots(sourcePath: string): Promise<SnapshotEntry[]> {
    return unwrapCommand(commands.listSnapshots(sourcePath))
  }

  async restoreSnapshot(snapshotId: string): Promise<string> {
    return unwrapCommand(commands.restoreSnapshot(snapshotId))
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

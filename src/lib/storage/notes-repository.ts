import type { StoragePort } from "./port"
import type {
  CustomProperty,
  FileMetadata,
  FsMutationResult,
  IdMigrationRecovery,
  IdMigrationRecoveryAction,
  LinkGraph,
  LoadVaultResult,
  NoteReadOutcome,
  NoteProperties,
  SearchResult,
  TreeItem,
  VaultPreflight,
  VaultTagEntry,
  WriteNoteOutcome,
} from "./types"

export class NotesRepository {
  constructor(private readonly port: () => StoragePort) {}

  async openVault(): Promise<string | null> {
    return this.port().openVault()
  }

  async startVaultWatcher(vaultPath: string): Promise<void> {
    return this.port().startVaultWatcher(vaultPath)
  }

  async stopVaultWatcher(): Promise<void> {
    return this.port().stopVaultWatcher()
  }

  async loadVaultData(vaultPath: string): Promise<LoadVaultResult> {
    return this.port().loadVaultData(vaultPath)
  }

  async loadActiveVaultData(): Promise<LoadVaultResult> {
    return this.port().loadActiveVaultData()
  }

  async preflightVault(vaultPath: string): Promise<VaultPreflight> {
    return this.port().preflightVault(vaultPath)
  }

  async applyIdMigration(vaultPath: string): Promise<void> {
    return this.port().applyIdMigration(vaultPath)
  }

  async inspectIdMigrations(vaultPath: string): Promise<IdMigrationRecovery[]> {
    return this.port().inspectIdMigrations(vaultPath)
  }

  async recoverIdMigration(
    vaultPath: string,
    journalPath: string,
    action: IdMigrationRecoveryAction,
  ): Promise<IdMigrationRecovery> {
    return this.port().recoverIdMigration(vaultPath, journalPath, action)
  }

  async listFiles(vaultPath: string): Promise<TreeItem[]> {
    return this.port().listFiles(vaultPath)
  }

  async searchNotes(query: string): Promise<SearchResult[]> {
    return this.port().searchNotes(query)
  }

  async readFile(path: string): Promise<string> {
    return this.port().readFile(path)
  }

  async readNote(vaultPath: string, noteId: string): Promise<NoteReadOutcome> {
    return this.port().readNote(vaultPath, noteId)
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.port().writeFile(path, content)
  }

  async writeNote(
    vaultPath: string,
    noteId: string,
    content: string,
    expectedGeneration: number | null,
    expectedRevision: string,
    originWindow: string,
  ): Promise<WriteNoteOutcome> {
    return this.port().writeNote(
      vaultPath,
      noteId,
      content,
      expectedGeneration,
      expectedRevision,
      originWindow,
    )
  }

  async restoreDeletedNote(
    vaultPath: string,
    noteId: string,
    path: string,
    content: string,
    sourceTemplate: string,
    expectedGeneration: number | null,
    originWindow: string,
  ): Promise<WriteNoteOutcome> {
    return this.port().restoreDeletedNote(
      vaultPath,
      noteId,
      path,
      content,
      sourceTemplate,
      expectedGeneration,
      originWindow,
    )
  }

  async saveConflictCopy(path: string, content: string): Promise<string> {
    return this.port().saveConflictCopy(path, content)
  }

  async createNote(vaultPath: string, parentPath: string, name: string): Promise<FsMutationResult> {
    return this.port().createNote(vaultPath, parentPath, name)
  }

  async createFile(vaultPath: string, name: string): Promise<string> {
    const result = await this.createNote(vaultPath, vaultPath, name)
    return result.primaryPath ?? `${vaultPath.replace(/\/$/u, "")}/${name}.md`
  }

  async getNoteMetadata(vaultPath: string, noteId: string): Promise<FileMetadata> {
    return this.port().getNoteMetadata(vaultPath, noteId)
  }

  async getFileMetadata(path: string): Promise<FileMetadata> {
    return this.port().getFileMetadata(path)
  }

  async getNoteProperties(vaultPath: string, noteId: string): Promise<NoteProperties> {
    return this.port().getNoteProperties(vaultPath, noteId)
  }

  async upsertCustomProperty(
    vaultPath: string,
    noteId: string,
    property: CustomProperty,
  ): Promise<CustomProperty> {
    return this.port().upsertCustomProperty(vaultPath, noteId, property)
  }

  async deleteCustomProperty(vaultPath: string, noteId: string, propertyId: string): Promise<void> {
    return this.port().deleteCustomProperty(vaultPath, noteId, propertyId)
  }

  async getLinkGraph(vaultPath: string): Promise<LinkGraph> {
    return this.port().getLinkGraph(vaultPath)
  }

  async listTags(vaultPath: string): Promise<VaultTagEntry[]> {
    return this.port().listTags(vaultPath)
  }
}

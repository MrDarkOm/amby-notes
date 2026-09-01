import type { StoragePort } from "./port"
import type {
  FsMutationResult,
  HistoryCleanupPreview,
  HistoryCleanupResult,
  HistoryRetention,
  HistoryStats,
  RefactorPreview,
  SnapshotEntry,
  SnapshotText,
  TrashEntry,
} from "./types"

export class HistoryRepository {
  constructor(private readonly port: () => StoragePort) {}

  async listSnapshots(sourcePath: string): Promise<SnapshotEntry[]> {
    return this.port().listSnapshots(sourcePath)
  }

  async getHistoryStats(): Promise<HistoryStats> {
    return this.port().getHistoryStats()
  }

  async previewHistoryCleanup(retention: HistoryRetention): Promise<HistoryCleanupPreview> {
    return this.port().previewHistoryCleanup(retention)
  }

  async cleanupHistory(retention: HistoryRetention): Promise<HistoryCleanupResult> {
    return this.port().cleanupHistory(retention)
  }

  async restoreSnapshot(snapshotId: string): Promise<string> {
    return this.port().restoreSnapshot(snapshotId)
  }

  async readSnapshotText(snapshotId: string): Promise<SnapshotText> {
    return this.port().readSnapshotText(snapshotId)
  }

  async listTrash(): Promise<TrashEntry[]> {
    return this.port().listTrash()
  }

  async restoreTrash(trashId: string): Promise<FsMutationResult> {
    return this.port().restoreTrash(trashId)
  }
  async purgeTrash(trashId: string): Promise<void> {
    return this.port().purgeTrash(trashId)
  }

  async previewRenameRefactor(
    vaultPath: string,
    path: string,
    newName: string,
  ): Promise<RefactorPreview> {
    return this.port().previewRenameRefactor(vaultPath, path, newName)
  }

  async previewMoveRefactor(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<RefactorPreview> {
    return this.port().previewMoveRefactor(vaultPath, sourcePath, targetPath)
  }
}

import {
  commands,
  type BackupCatalog,
  type BackupInfo,
  type RestoredBackup,
  type Result,
  type SyncError,
} from "../bindings"
export type { BackupCatalog, BackupInfo }

export class BackupOperationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "BackupOperationError"
  }
}
export interface BackupPort {
  available: boolean
  list(vault: string): Promise<BackupCatalog>
  verify(generation: number, id: string): Promise<BackupInfo>
  restore(generation: number, id: string, operationId: string): Promise<RestoredBackup | null>
}
async function call<T>(request: Promise<Result<T, SyncError>>): Promise<T> {
  let result: Result<T, SyncError>
  try {
    result = await request
  } catch {
    throw new BackupOperationError("backup_failed")
  }
  if (result.status === "ok") return result.data
  throw new BackupOperationError(result.error.code)
}
const unavailable = async (): Promise<never> => {
  throw new BackupOperationError("unavailable")
}
const unavailableBackupPort: BackupPort = {
  available: false,
  list: unavailable,
  verify: unavailable,
  restore: unavailable,
}
export function createBackupPort(native: boolean): BackupPort {
  if (!native) return unavailableBackupPort
  return {
    available: true,
    list: (vault) => call(commands.listVaultBackups(vault)),
    verify: (generation, id) => call(commands.verifyVaultBackup(generation, id)),
    restore: (generation, id, operationId) =>
      call(commands.restoreVaultBackup(generation, id, operationId)),
  }
}

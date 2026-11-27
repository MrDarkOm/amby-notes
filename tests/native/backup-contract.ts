import { createBackupPort, BackupOperationError } from "../../src/lib/storage/backup-repository"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
export const nativeBackupCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "backup catalog and byte verification cross real IPC and reject a stale vault activation",
    async run({ adapter, vaultPath }) {
      const root = (window as unknown as { __AMBY_NATIVE_TEST_ROOT__: string })
        .__AMBY_NATIVE_TEST_ROOT__
      const source = joinStoragePath(root, ".amby/native-backup-fixture")
      const port = createBackupPort(true)
      await adapter.loadVaultData(source)
      const catalog = await port.list(source)
      check(catalog.backups.length === 1, "Expected one immutable backup")
      check(catalog.backups[0].status === "unchecked", "Metadata must not claim verification")
      const verified = await port.verify(catalog.generation, catalog.backups[0].id)
      check(
        verified.status === "verified" && verified.files === 2,
        "Expected verified original files and .amby sidecars",
      )
      await adapter.loadVaultData(vaultPath)
      let stale: unknown
      try {
        await port.verify(catalog.generation, verified.id)
      } catch (error) {
        stale = error
      }
      check(
        stale instanceof BackupOperationError && stale.code === "backup_stale_vault",
        "Old catalog must not target the newly activated vault",
      )
    },
  },
]

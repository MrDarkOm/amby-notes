import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useVaultStore } from "../use-vault-store"
import { useSyncNoticesStore } from "./use-sync-notices-store"

/**
 * True while the note at `path` is announced as deleted on another computer and the way back from
 * the archive has not failed. After a failure the general "file deleted" strip, which restores the
 * open buffer, must be shown again so the text can still be saved.
 */
export function useRemoteDeletedNotice(path: string | undefined): boolean {
  const vault = useVaultStore((state) => state.vault)
  return useSyncNoticesStore((state) => {
    if (!path || !vault) return false
    const relative = relativeToVault(path, vault).normalize("NFC")
    return state.remoteDeleted.includes(relative) && !state.restoreFailed.includes(relative)
  })
}

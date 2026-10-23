import { listTrash, restoreTrash } from "@/lib/storage"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useSyncNoticesStore } from "./use-sync-notices-store"

/**
 * Brings a note that another computer deleted back from the archive of the vault
 * (`.amby/trash/`), by the same path the Archive panel uses. Throws when the archive has no entry
 * for the path, so the message stays and the person can look in the Archive.
 */
export async function restoreRemoteDeleted(vaultPath: string, relative: string): Promise<void> {
  const entries = await listTrash()
  const entry = entries
    .filter((item) => relativeToVault(item.originalPath, vaultPath) === relative)
    .sort((a, b) => b.deletedAtMs - a.deletedAtMs)[0]
  if (!entry) throw new Error("not_in_archive")
  await restoreTrash(entry.id)
  useSyncNoticesStore.getState().clearRemoteDeleted(relative)
  window.dispatchEvent(new CustomEvent("amby:archive-changed"))
}

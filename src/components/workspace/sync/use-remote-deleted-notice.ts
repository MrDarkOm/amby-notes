import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useVaultStore } from "../use-vault-store"
import { useSyncNoticesStore } from "./use-sync-notices-store"

/** True while the note at `path` is announced as deleted on another computer. */
export function useRemoteDeletedNotice(path: string | undefined): boolean {
  const vault = useVaultStore((state) => state.vault)
  return useSyncNoticesStore((state) =>
    Boolean(path && vault && state.remoteDeleted.includes(relativeToVault(path, vault))),
  )
}

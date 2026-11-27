import type { JournalKind } from "@/lib/notices/notice-journal"
import { findSyncSnapshot } from "@/lib/notices/sync-snapshot"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { useVaultStore } from "../use-vault-store"

/**
 * After a journal entry about a change sync made by itself, looks up the snapshot it took before and
 * keeps its id in the entry, so the entry can offer "Вернуть". Nothing happens when there is none.
 */
export function rememberSyncSnapshot(kind: JournalKind, subject: string, target: string): void {
  const vault = useVaultStore.getState().vault
  if (vault === null) return
  void findSyncSnapshot(vault, target).then((snapshotId) => {
    // Another vault was opened meanwhile: the entry belongs to the one that is gone.
    if (!snapshotId || useVaultStore.getState().vault !== vault) return
    useNoticeJournalStore.getState().amend(kind, subject, { snapshotId })
  })
}

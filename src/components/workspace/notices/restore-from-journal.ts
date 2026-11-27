import { errorType, logger } from "@/lib/logger"
import type { JournalEntry } from "@/lib/notices/notice-journal"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { restoreSnapshot } from "@/lib/storage"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"

/** What happened when "Вернуть" was pressed. */
export type RestoreOutcome = "restored" | "saveFirst" | "failed"

/** Whether an entry can give back the version sync replaced (docs/notices.md, section 10). */
export function canRestore(entry: JournalEntry): boolean {
  return Boolean(entry.target && entry.params.snapshotId && !entry.params.restored)
}

/**
 * Puts back the version sync replaced, as the history panel does: unsaved text is saved first, and a note
 * that still has unsaved edits or an outside change is not touched. The current text goes into the history
 * first (the restore takes its own snapshot), so this can be undone from there.
 */
export async function restoreFromJournal(entry: JournalEntry): Promise<RestoreOutcome> {
  const { vault, generation } = useVaultStore.getState()
  const snapshotId = entry.params.snapshotId
  if (vault === null || !entry.target || !snapshotId) return "failed"
  const flushed = await flushAutosaveGeneration(generation)
  const state = useDocStore.getState()
  const target = entry.target.normalize("NFC")
  const document = Object.values(state.openDocs).find(
    (doc) => relativeToVault(doc.path, vault).normalize("NFC") === target,
  )
  if (
    !flushed.flushed ||
    (document && (state.unsavedFileIds.has(document.id) || state.externalConflicts[document.id]))
  ) {
    return "saveFirst"
  }
  try {
    await restoreSnapshot(snapshotId)
  } catch (error) {
    logger.warn("notices.restore_failed", { errorType: errorType(error) })
    return "failed"
  }
  useNoticeJournalStore.getState().amend(entry.kind, entry.subject, { restored: "1" })
  return "restored"
}

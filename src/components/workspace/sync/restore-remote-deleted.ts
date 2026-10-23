import { listTrash, readNote, restoreTrash } from "@/lib/storage"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useDocStore } from "../use-doc-store"
import { useSyncNoticesStore } from "./use-sync-notices-store"

/**
 * Brings a note that another computer deleted back from the archive of the vault
 * (`.amby/trash/`), by the same path the Archive panel uses, then reconciles the open document
 * the way the watcher does when a file reappears: the same text is simply saved, a different one
 * (unsaved edits) becomes the usual external conflict, so the buffer is never dropped. Throws when
 * the archive has no entry for the path; the general "file deleted" strip then takes over.
 */
export async function restoreRemoteDeleted(vaultPath: string, relative: string): Promise<void> {
  const notices = useSyncNoticesStore.getState()
  try {
    const entries = await listTrash()
    const entry = entries
      .filter((item) => relativeToVault(item.originalPath, vaultPath).normalize("NFC") === relative)
      .sort((a, b) => b.deletedAtMs - a.deletedAtMs)[0]
    if (!entry) throw new Error("not_in_archive")
    await restoreTrash(entry.id)
  } catch (error) {
    notices.setRestoreFailed(relative, true)
    throw error
  }
  await reconcileOpenDocument(vaultPath, relative)
  useSyncNoticesStore.getState().clearRemoteDeleted(relative)
  window.dispatchEvent(new CustomEvent("amby:archive-changed"))
}

async function reconcileOpenDocument(vaultPath: string, relative: string): Promise<void> {
  const docs = useDocStore.getState()
  const open = Object.values(docs.openDocs).find(
    (doc) => relativeToVault(doc.path, vaultPath).normalize("NFC") === relative,
  )
  if (!open) return
  try {
    const note = await readNote(vaultPath, open.noteId ?? open.id)
    const latest = useDocStore.getState().openDocs[open.id]
    if (!latest) return
    const { patchDoc, markSaved, clearExternalConflict, setExternalConflict } =
      useDocStore.getState()
    patchDoc(open.id, { externallyDeleted: false })
    if (note.content === latest.content) {
      patchDoc(open.id, { revision: note.revision, source: note.source })
      markSaved(open.id)
      clearExternalConflict(open.id)
    } else {
      setExternalConflict({
        fileId: open.id,
        path: latest.path,
        localContent: latest.content,
        externalContent: note.content,
        externalRevision: note.revision,
        sourceTemplate: note.source,
      })
    }
  } catch {
    // The file is back on disk; the watcher or the next read reconciles the buffer.
    useDocStore.getState().patchDoc(open.id, { externallyDeleted: false })
  }
}

import { readNote } from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"
import { hasUnsavedAutosave, waitForInFlightAutosave } from "./autosave/autosave-lifecycle"
import { isUnchangedNoteRevision } from "./external-note-reconciliation"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"

/**
 * Reads every open note again after the vault was refreshed (a sync pull). The buffer of a note is
 * replaced only while it is clean, and that is asked afresh after each `await`: the user may have
 * started typing while another note was being read (SAVE-06). A note with unsaved edits, or one
 * whose save is still queued, becomes an external conflict instead, exactly as in the watcher.
 */
export async function reloadOpenNotes(vault: string): Promise<void> {
  const generation = useVaultStore.getState().generation
  for (const [id, doc] of Object.entries(useDocStore.getState().openDocs)) {
    if (doc.path.endsWith(".canvas") || doc.path.endsWith(".excalidraw")) continue
    const key = { generation, kind: "markdown" as const, documentId: id }
    try {
      await waitForInFlightAutosave(key)
      const revisionBeforeRead = useDocStore.getState().openDocs[id]?.revision
      // A container layer is read by its note id; the key of its buffer is its own id.
      const note = await readNote(vault, doc.noteId ?? id)
      await waitForInFlightAutosave(key)
      if (useVaultStore.getState().generation !== generation) return
      const store = useDocStore.getState()
      const latest = store.openDocs[id]
      if (!latest) continue
      if (isUnchangedNoteRevision(note.revision, latest.revision, revisionBeforeRead)) {
        if (note.revision === latest.revision && note.source !== latest.source) {
          store.patchDoc(id, { source: note.source })
        }
        continue
      }
      // Fresh state, taken after the last await: the flag and the autosave queue together.
      if (store.unsavedFileIds.has(id) || hasUnsavedAutosave(key)) {
        store.setExternalConflict({
          fileId: id,
          path: latest.path,
          localContent: latest.content,
          externalContent: note.content,
          externalRevision: note.revision,
          sourceTemplate: note.source,
        })
        continue
      }
      store.patchDoc(id, {
        content: note.content,
        revision: note.revision,
        source: note.source,
      })
      store.markSaved(id)
    } catch (error) {
      logger.warn("refresh_vault.open_document_reload_failed", { errorType: errorType(error) })
    }
  }
}

import { listArchive, readNote, restoreArchive } from "@/lib/storage"
import { dispatchArchiveChanged } from "../use-archive-tree-refresh"
import { mutationPaths } from "../workspace-mutations"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"

/**
 * The archive entry that holds the file of `path` (a path of the note in the vault), if another computer
 * moved it there (К1, К13). The newest entry wins.
 */
export async function findArchivedCopy(vaultPath: string, path: string) {
  const relative = relativeToVault(path, vaultPath).normalize("NFC")
  const entries = await listArchive()
  return entries
    .filter((entry) => entry.originalPath.normalize("NFC") === relative)
    .sort((a, b) => b.archivedAtMs - a.archivedAtMs)[0]
}

/** A path inside the archive of the vault: a note there is archived, not moved (К13). */
export function isArchivePath(path: string): boolean {
  return /(^|[\\/])\.amby[\\/]archive[\\/]/u.test(path)
}

/**
 * "Вернуть из архива" (К13): the file comes back from `.amby/archive/` by К6 (without replacing; a taken
 * path gets a free name), then the open note is reconciled the way the watcher does when a file reappears:
 * the same text is saved, different (unsaved) text becomes the usual external conflict, so the buffer is
 * never dropped. Throws when the archive has no such file; the card then stays.
 */
export async function restoreArchivedNote(vaultPath: string, docId: string): Promise<void> {
  const open = useDocStore.getState().openDocs[docId]
  if (!open) return
  const entry = await findArchivedCopy(vaultPath, open.path)
  if (!entry) throw new Error("not_in_archive")
  const restored = await restoreArchive(entry.id)
  const finalPath = restored.primaryPath ?? open.path
  dispatchArchiveChanged({ paths: mutationPaths(restored) })
  if (useVaultStore.getState().vault !== vaultPath) return
  try {
    const note = await readNote(vaultPath, open.noteId ?? open.id)
    const latest = useDocStore.getState().openDocs[docId]
    if (!latest) return
    const { patchDoc, markSaved, clearExternalConflict, setExternalConflict } =
      useDocStore.getState()
    patchDoc(docId, { path: finalPath, externallyDeleted: false, externallyArchived: false })
    if (note.content === latest.content) {
      patchDoc(docId, { revision: note.revision, source: note.source })
      markSaved(docId)
      clearExternalConflict(docId)
    } else {
      setExternalConflict({
        fileId: docId,
        path: finalPath,
        localContent: latest.content,
        externalContent: note.content,
        externalRevision: note.revision,
        sourceTemplate: note.source,
      })
    }
  } catch {
    // The file is back on disk; the watcher or the next read reconciles the buffer.
    useDocStore
      .getState()
      .patchDoc(docId, { path: finalPath, externallyDeleted: false, externallyArchived: false })
  }
}

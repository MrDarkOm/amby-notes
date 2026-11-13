import { errorType, logger } from "@/lib/logger"
import { getNoteProperties } from "@/lib/storage"
import { propertyReadIsCurrent, propertyVersion } from "../note-mutation-queue"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"

/**
 * Rereads the properties of the open notes after another computer changed them (docs/sync-plan.md,
 * З65). The panel keeps its own copy of the properties; a pass of synchronisation or the reload of a
 * clean note changes the files under it, so the copy has to be read again.
 */

/** Does any of the written paths (relative to the vault) belong to the properties of notes? */
export function touchesNoteProperties(paths: string[]): boolean {
  return paths.some(
    (path) =>
      path === ".amby/properties.json" ||
      path === ".amby/properties" ||
      path.startsWith(".amby/properties/"),
  )
}

/**
 * Reads the properties of the open notes again (those with a panel, or only `onlyIds`) and shows
 * them. A note whose own edit is still going is left alone, and so is a note that began an edit
 * while the answer was coming: the local edit is newer than any file. The text of the note and its
 * revision are never touched.
 */
export async function rereadOpenNoteProperties(
  vault: string,
  generation: number,
  onlyIds?: readonly string[],
): Promise<void> {
  const isCurrent = () => {
    const state = useVaultStore.getState()
    return state.vault === vault && state.generation === generation
  }
  if (!isCurrent()) return
  const docs = Object.values(useDocStore.getState().openDocs).filter(
    (doc) => doc.noteProperties && (!onlyIds || onlyIds.includes(doc.id)),
  )
  await Promise.all(
    docs.map(async (doc) => {
      const noteId = doc.noteId ?? doc.id
      const version = propertyVersion(generation, noteId)
      if (!propertyReadIsCurrent(generation, noteId, version)) return
      try {
        const noteProperties = await getNoteProperties(vault, noteId)
        if (!isCurrent() || !propertyReadIsCurrent(generation, noteId, version)) return
        if (!useDocStore.getState().openDocs[doc.id]) return
        useDocStore.getState().patchDoc(doc.id, { noteProperties })
      } catch (error) {
        logger.warn("properties.reread_failed", { errorType: errorType(error) })
      }
    }),
  )
}

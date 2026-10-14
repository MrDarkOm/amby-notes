import * as React from "react"
import {
  getDatabaseNoteContext,
  listNoteReferences,
  type DatabaseNoteContext,
  type NoteReference,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useProjectStore } from "../project-store"
import { worldSectionOf, type WorldSection } from "./dossier-model"

export interface NoteDossier {
  context: DatabaseNoteContext
  world: WorldSection
  references: NoteReference[]
}

/**
 * The dossier of a page, or `null` when the page is not one: a note outside the creative
 * projects, or in their text or notes. Nothing is asked of the backend while there are no
 * projects, so an ordinary vault pays nothing for the feature. The page keeps showing its
 * previous answer while a refresh runs, so the header does not flicker.
 */
export function useNoteDossier(noteId: string | null): NoteDossier | null {
  const catalog = useProjectStore((state) => state.catalog)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const hasProjects = (catalog?.workshops.length ?? 0) > 0
  const [answer, setAnswer] = React.useState<{
    noteId: string
    dossier: NoteDossier | null
  } | null>(null)

  React.useEffect(() => {
    if (!noteId || !hasProjects) {
      setAnswer(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      let dossier: NoteDossier | null = null
      try {
        const context = await getDatabaseNoteContext(noteId)
        const world = context ? worldSectionOf(catalog, context.databaseId) : null
        if (context && world) {
          dossier = { context, world, references: await listNoteReferences(noteId) }
        }
      } catch {
        // A page whose context cannot be read is shown as the plain note it also is.
        dossier = null
      }
      if (!cancelled) setAnswer({ noteId, dossier })
    })()
    return () => {
      cancelled = true
    }
  }, [catalog, hasProjects, invalidationSeq, noteId])

  return answer && answer.noteId === noteId ? answer.dossier : null
}

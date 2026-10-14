import * as React from "react"
import {
  getDatabaseNoteContext,
  listNoteReferences,
  type DatabaseNoteContext,
  type NoteReference,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useProjectStore } from "../project-store"
import { textStoryOf, worldSectionOf, type TextPlace, type WorldSection } from "./dossier-model"

export interface NoteDossier {
  context: DatabaseNoteContext
  world: WorldSection
  references: NoteReference[]
}

/** Where a creative page stands: a world page with a dossier, or a page of a story's text. */
export type NotePlace =
  | { kind: "world"; dossier: NoteDossier }
  | { kind: "text"; text: TextPlace; context: DatabaseNoteContext }

/**
 * Where the page stands in the creative workshop, or `null` when it is a plain note: outside the
 * workshops or in their notes. Nothing is asked of the backend while there are no projects, so an
 * ordinary vault pays nothing for the feature. The page keeps showing its previous answer while a
 * refresh runs, so the header does not flicker. A page of the text asks only for its context; the
 * references are read for a world page alone.
 */
export function useNotePlace(noteId: string | null): NotePlace | null {
  const catalog = useProjectStore((state) => state.catalog)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const hasProjects = (catalog?.workshops.length ?? 0) > 0
  const [answer, setAnswer] = React.useState<{
    noteId: string
    place: NotePlace | null
  } | null>(null)

  React.useEffect(() => {
    if (!noteId || !hasProjects) {
      setAnswer(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      let place: NotePlace | null = null
      try {
        const context = await getDatabaseNoteContext(noteId)
        const world = context ? worldSectionOf(catalog, context.databaseId) : null
        const text = context && !world ? textStoryOf(catalog, context.databaseId) : null
        if (context && world) {
          place = {
            kind: "world",
            dossier: { context, world, references: await listNoteReferences(noteId) },
          }
        } else if (context && text) {
          place = { kind: "text", text, context }
        }
      } catch {
        // A page whose context cannot be read is shown as the plain note it also is.
        place = null
      }
      if (!cancelled) setAnswer({ noteId, place })
    })()
    return () => {
      cancelled = true
    }
  }, [catalog, hasProjects, invalidationSeq, noteId])

  return answer && answer.noteId === noteId ? answer.place : null
}

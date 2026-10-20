import * as React from "react"
import { useTranslation } from "react-i18next"
import { getDatabaseNoteContext, type DatabaseNoteContext } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { noteTrail, trailDatabaseIds, type TrailStep } from "./note-trail"
import { useProjectStore } from "./project-store"
import { useDatabaseRows } from "./workshop/use-database-rows"

/** The last trails, so a note opened again (or its neighbour) does not show the folders first. */
const MAX_REMEMBERED = 300
const remembered = new Map<string, TrailStep[]>()

function remember(noteId: string, steps: TrailStep[] | null) {
  remembered.delete(noteId)
  if (!steps) return
  remembered.set(noteId, steps)
  if (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
}

/**
 * The logical path of a note of the active workshop (`noteTrail`), or `null` while it is not known
 * and for a note that is not in the workshop. Nothing is asked of the backend while there are no
 * projects, so an ordinary vault pays nothing. The previous answer for the note stays on screen
 * while a refresh runs, so the header does not flicker.
 */
export function useNoteTrail(noteId: string | undefined): TrailStep[] | null {
  const { t } = useTranslation()
  const catalog = useProjectStore((state) => state.catalog)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const hasProjects = (catalog?.workshops.length ?? 0) > 0
  const [answer, setAnswer] = React.useState<{
    noteId: string
    context: DatabaseNoteContext | null
  } | null>(null)

  React.useEffect(() => {
    if (!noteId || !hasProjects) {
      setAnswer(null)
      return undefined
    }
    let cancelled = false
    void getDatabaseNoteContext(noteId)
      .catch(() => null)
      .then((context) => {
        if (!cancelled) setAnswer({ noteId, context })
      })
    return () => {
      cancelled = true
    }
  }, [hasProjects, invalidationSeq, noteId])

  const context = answer && answer.noteId === noteId ? answer.context : undefined
  const idsKey = context ? trailDatabaseIds(catalog, context.databaseId).join("|") : ""
  const ids = React.useMemo(() => (idsKey ? idsKey.split("|") : []), [idsKey])
  const data = useDatabaseRows(ids, dataNonce)

  if (!noteId || !hasProjects) return null
  // Not asked yet, or its rows are still being read: the last answer, if any, holds.
  if (context === undefined || !ids.every((id) => data.rows[id] !== undefined)) {
    return remembered.get(noteId) ?? null
  }
  const steps = context
    ? noteTrail({
        catalog,
        databaseId: context.databaseId,
        row: context.row,
        rows: data.rows,
        labels: {
          workshop: t("panels.creative"),
          standalone: t("creative.workshop.standalone"),
          universe: t("creative.kind.universe"),
        },
      })
    : null
  remember(noteId, steps)
  return steps
}

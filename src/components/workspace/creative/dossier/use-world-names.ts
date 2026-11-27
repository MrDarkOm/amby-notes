import * as React from "react"
import type { DatabaseRow, WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { storySection } from "../workshop/workshop-model"
import { mentionNames } from "./mention-model"

export interface WorldEntity {
  row: DatabaseRow
  section: WorkshopSectionSummary
}

/**
 * The names a page of the text marks: every character and location of the workshop, by its
 * title and the words of a title of several words (as "Found by name" searches them). Read from
 * the rows of those bases; `null` workshop reads nothing.
 */
export function useWorldNames(workshop: WorkshopSummary | null): {
  entries: { name: string; noteId: string }[]
  entityOf: (noteId: string) => WorldEntity | null
} {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const sections = React.useMemo(
    () =>
      [storySection(workshop, "characters"), storySection(workshop, "locations")].filter(
        (section): section is WorkshopSectionSummary => section !== null,
      ),
    [workshop],
  )
  const databaseIds = React.useMemo(() => sections.map((section) => section.databaseId), [sections])
  const data = useDatabaseRows(databaseIds, dataNonce)
  return React.useMemo(() => {
    const entries: { name: string; noteId: string }[] = []
    const entities = new Map<string, WorldEntity>()
    for (const section of sections) {
      for (const row of data.rows[section.databaseId] ?? []) {
        entities.set(row.noteId, { row, section })
        for (const name of mentionNames(row.title, "")) entries.push({ name, noteId: row.noteId })
      }
    }
    return { entries, entityOf: (noteId: string) => entities.get(noteId) ?? null }
  }, [data.rows, sections])
}

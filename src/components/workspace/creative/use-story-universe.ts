import * as React from "react"
import type { StorySummary, WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "./creative-nav-store"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { relationTargetsOf } from "./workshop/workshop-model"

/**
 * The universe a story is in: the relation of its card in the stories base, read once for the
 * page's trail. `null` while it is read, and for a story that no universe holds.
 */
export function useStoryUniverse(
  workshop: WorkshopSummary | null,
  story: StorySummary | null,
): string | null {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const storiesSection = workshop?.sections.find(
    (section) => section.role === "stories" && section.state !== "missing",
  )
  const propertyId = storiesSection?.universePropertyId ?? null
  const databaseId = story?.cardNoteId && propertyId ? (storiesSection?.databaseId ?? null) : null
  const ids = React.useMemo(() => (databaseId ? [databaseId] : []), [databaseId])
  const data = useDatabaseRows(ids, dataNonce)
  const card = databaseId
    ? data.rows[databaseId]?.find((row) => row.noteId === story?.cardNoteId)
    : undefined
  return card && propertyId ? (relationTargetsOf(card.valuesJson, propertyId)[0] ?? null) : null
}

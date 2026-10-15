import * as React from "react"
import type { WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { useDatabaseRows } from "./use-database-rows"
import type { UniverseItem } from "./workshop-model"

export interface UniversesState {
  /** The pages of the "Universes" base, named by the rows. */
  universes: UniverseItem[]
  /** The base's ID, or `null` when the workshop has none. */
  databaseId: string | null
  /** Whether the base was read (or there is none), so a missing choice may be dropped. */
  known: boolean
}

/**
 * The universes of a workshop: the rows of its "Universes" base. The card at the foot of the panel
 * and the filter of the lists read them from here.
 */
export function useUniverses(workshop: WorkshopSummary | null): UniversesState {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const databaseId =
    workshop?.sections.find(
      (section) => section.role === "universes" && section.state !== "missing",
    )?.databaseId ?? null
  const ids = React.useMemo(() => (databaseId ? [databaseId] : []), [databaseId])
  const data = useDatabaseRows(ids, dataNonce)
  const rows = databaseId ? data.rows[databaseId] : undefined
  const universes = React.useMemo(
    () => (rows ?? []).map((row) => ({ noteId: row.noteId, title: row.title })),
    [rows],
  )
  return {
    universes,
    databaseId,
    known:
      workshop !== null && (databaseId === null || (data.status === "ready" && rows !== undefined)),
  }
}

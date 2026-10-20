import * as React from "react"
import type { DatabaseRow, WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { buildMembership, type Membership } from "../workshop/workshop-model"

const NO_ROWS: DatabaseRow[] = []

export interface WorkshopSectionData {
  loading: boolean
  failed: boolean
  /** Every page of the section: the workshop's page shows the whole shared database. */
  rows: DatabaseRow[]
  /** Who is in which story, for the chips on the cards. */
  membership: Membership
}

/**
 * The whole of one section for the workshop's page, with the membership its cards need: the
 * section's own rows, the stories base and the text of every story (the same inputs the scope
 * data reads, but only for this one section). With no section nothing is read.
 */
export function useWorkshopSectionData(
  workshop: WorkshopSummary | null,
  section: WorkshopSectionSummary | undefined,
): WorkshopSectionData {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const storiesSection = workshop?.sections.find(
    (candidate) => candidate.role === "stories" && candidate.state !== "missing",
  )
  const ids = React.useMemo(
    () =>
      !workshop || !section
        ? []
        : [
            section.databaseId,
            ...(storiesSection ? [storiesSection.databaseId] : []),
            ...workshop.stories.flatMap((story) => (story.databaseId ? [story.databaseId] : [])),
          ],
    [section, storiesSection, workshop],
  )
  const data = useDatabaseRows(ids, dataNonce)
  const membership = React.useMemo(
    () =>
      buildMembership({
        stories: workshop?.stories ?? [],
        sections: workshop?.sections ?? [],
        rows: data.rows,
      }),
    [data.rows, workshop?.sections, workshop?.stories],
  )
  return {
    loading: ids.length > 0 && (data.status === "loading" || data.status === "idle"),
    failed: data.status === "error",
    rows: (section ? data.rows[section.databaseId] : undefined) ?? NO_ROWS,
    membership,
  }
}

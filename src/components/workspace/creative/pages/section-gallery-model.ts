import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { entityItemsOf, groupEntities, groupPropertyOf } from "../workshop/workshop-model"

/** One category of a section: its heading (none when the section has a single group) and pages. */
export interface GalleryGroup {
  key: string
  /** `null` when the section is one group and needs no heading. */
  label: string | null
  color: string | null
  rows: DatabaseRow[]
}

/**
 * A section's pages in the categories its database's first grouped view uses (the Select or
 * Status it is grouped by): the options in their own order, pages with no value last under the
 * name asked for, each group by title. A section with no such property, or whose pages all fall
 * in one group, is one group without a heading.
 */
export function galleryGroups(
  rows: readonly DatabaseRow[],
  summary: DatabaseSummary | undefined,
  noCategoryLabel: string,
): GalleryGroup[] {
  if (rows.length === 0) return []
  const byId = new Map(rows.map((row) => [row.noteId, row]))
  const property = groupPropertyOf(summary)
  const groups = groupEntities(
    entityItemsOf(rows, summary?.databaseId ?? "", ""),
    property ? "importance" : "none",
    { groupProperty: () => property, sharedLabel: "", noValueLabel: noCategoryLabel },
  )
  return groups.map((group) => ({
    key: group.key,
    label: groups.length === 1 ? null : group.label,
    color: group.color,
    rows: group.items.flatMap((item) => byId.get(item.noteId) ?? []),
  }))
}

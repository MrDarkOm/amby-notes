import type { DatabaseRow } from "@/lib/storage"
import type { Membership } from "../workshop/workshop-model"

/** A universe page shows a page of the world only when this many of its stories hold it. */
export const SHARED_MIN_STORIES = 2

export interface SharedRows {
  /** The pages that two or more of the universe's stories hold. */
  shared: DatabaseRow[]
  /** How many pages only one story holds (or none of this universe's): kept off the page. */
  hidden: number
}

/**
 * The pages of a universe's world that belong to the universe as a whole: those held by at least
 * `min` of the universe's own stories (`membership.storiesOf`, narrowed to `storyIds`). A page
 * that only one story holds is that story's and is seen on its page. The rows come in already
 * filtered by the universe (`scopeEntities`).
 */
export function sharedInUniverse(
  rows: readonly DatabaseRow[],
  membership: Membership,
  storyIds: readonly string[],
  min: number = SHARED_MIN_STORIES,
): SharedRows {
  const own = new Set(storyIds)
  const shared = rows.filter(
    (row) => membership.storiesOf(row.noteId).filter((id) => own.has(id)).length >= min,
  )
  return { shared, hidden: rows.length - shared.length }
}

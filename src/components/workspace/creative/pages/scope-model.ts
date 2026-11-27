import type { DatabaseRow } from "@/lib/storage"
import type { Membership } from "../workshop/workshop-model"

/** IDs of rows held by two or more stories of this universe. */
export function sharedInUniverse(
  rows: readonly DatabaseRow[],
  membership: Membership,
  storyIds: readonly string[],
): ReadonlySet<string> {
  const own = new Set(storyIds)
  return new Set(
    rows
      .filter((row) => membership.storiesOf(row.noteId).filter((id) => own.has(id)).length >= 2)
      .map((row) => row.noteId),
  )
}

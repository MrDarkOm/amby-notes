import type { StoryEntry } from "./story-list-model"

/** The card IDs of the stories in the order given: what the stories base keeps as `manualOrder`. */
export function cardIdsOf(entries: readonly StoryEntry[]): string[] {
  return entries.flatMap((entry) => (entry.cardNoteId ? [entry.cardNoteId] : []))
}

/**
 * The order after `storyId` moved to position `to` among `entries` (clamped to the ends); `null`
 * when nothing would change or the story cannot be placed (no card, or not in the list). The
 * result is the full list of card IDs, which is what the view's `manualOrder` holds.
 */
export function orderAfterMove(
  entries: readonly StoryEntry[],
  storyId: string,
  to: number,
): string[] | null {
  const from = entries.findIndex((entry) => entry.storyId === storyId)
  if (from === -1 || !entries[from].cardNoteId) return null
  const target = Math.max(0, Math.min(entries.length - 1, to))
  if (target === from) return null
  const next = [...entries]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return cardIdsOf(next)
}

/** The order after a story steps one place earlier (`-1`) or later (`1`). */
export function orderAfterStep(
  entries: readonly StoryEntry[],
  storyId: string,
  direction: -1 | 1,
): string[] | null {
  const from = entries.findIndex((entry) => entry.storyId === storyId)
  return from === -1 ? null : orderAfterMove(entries, storyId, from + direction)
}

/**
 * The saved order with a universe's stories put in the new order. The stories base is shared by
 * every universe, so its `manualOrder` also holds the places of other universes' stories: they
 * keep their places, the universe's own stories take the places theirs had (in the new order),
 * and a story with no place yet is put after the rest.
 */
export function mergeStoryOrder(
  existing: readonly string[],
  reordered: readonly string[],
): string[] {
  const mine = new Set(reordered)
  const queue = [...reordered]
  const merged: string[] = []
  for (const id of existing) {
    if (!mine.has(id)) merged.push(id)
    else if (queue.length > 0) merged.push(queue.shift() as string)
  }
  return [...merged, ...queue]
}

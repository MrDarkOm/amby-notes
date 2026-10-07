import type { DatabaseRow } from "@/lib/storage"

/** Where a dragged row lands relative to the row it is dropped on. */
export type RowDropPlacement = "before" | "after"

/**
 * The rows in the order the user placed them: listed rows first, in list order, then the rest
 * in the order they arrived. Mirrors the backend, so a reorder shows at once and the next
 * query returns the same sequence.
 */
export function applyManualOrder(rows: DatabaseRow[], manualOrder: string[]): DatabaseRow[] {
  if (manualOrder.length === 0 || rows.length < 2) return rows
  const rank = new Map(manualOrder.map((id, index) => [id, index]))
  const ordered = rows
    .map((row, index) => ({ row, index, rank: rank.get(row.noteId) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.row)
  return ordered.every((row, index) => row === rows[index]) ? rows : ordered
}

/**
 * The new order after `movedId` is dropped before or after `targetId`. `displayedIds` is what the
 * user sees (loaded rows, in order): rows nobody placed yet join the list after the placed ones,
 * so the visible sequence is kept exactly and only the moved row changes place. Rows that are
 * not loaded keep their entries and their relative order. Returns `null` when nothing changes.
 */
export function moveRowInOrder(
  manualOrder: string[],
  displayedIds: string[],
  movedId: string,
  targetId: string,
  placement: RowDropPlacement,
): string[] | null {
  if (movedId === targetId) return null
  if (!displayedIds.includes(movedId) || !displayedIds.includes(targetId)) return null
  const placed = new Set(manualOrder)
  const base = [...manualOrder, ...displayedIds.filter((id) => !placed.has(id))].filter(
    (id) => id !== movedId,
  )
  const targetIndex = base.indexOf(targetId)
  if (targetIndex === -1) return null
  base.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, movedId)
  // Same visible sequence as before: nothing to save.
  const visibleBefore = displayedIds.join("\n")
  const shown = new Set(displayedIds)
  const visibleAfter = base.filter((id) => shown.has(id)).join("\n")
  return visibleBefore === visibleAfter ? null : base
}

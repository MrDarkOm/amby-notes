import type { RowDropPlacement } from "./row-order"

/** The row a pointer over row `index` of the original layout means, as a hit-test answer. */
export function dragTarget(
  rowIds: string[],
  movedId: string,
  index: number,
): { overId: string; placement: RowDropPlacement } | null {
  if (rowIds.length === 0) return null
  const from = rowIds.indexOf(movedId)
  const target = Math.min(Math.max(index, 0), rowIds.length - 1)
  return { overId: rowIds[target], placement: target > from ? "after" : "before" }
}

/**
 * How far row `index` is moved while row `from` is lifted over row `to`: the lifted row follows
 * the pointer (kept inside the list), the rows it passes slide one step out of its way.
 */
export function dragShift({
  index,
  from,
  to,
  count,
  step,
  pointerDelta,
}: {
  index: number
  from: number
  to: number
  count: number
  /** The lifted row's height: the room the others make. */
  step: number
  pointerDelta: number
}): number {
  if (index === from) {
    return Math.min(Math.max(pointerDelta, -from * step), (count - 1 - from) * step)
  }
  if (from < to && index > from && index <= to) return -step
  if (from > to && index >= to && index < from) return step
  return 0
}

// Shared by the block menus (the "/" and "+" list, the block actions and their "Turn into"
// list): moving a choice with the arrow keys must keep it in view.

const SCROLL_PARENTS = ".amby-block-panel-body, .amby-turn-into-menu"

/** The next choice among `count`, wrapping around at both ends. */
export function stepIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0
  return (Math.min(Math.max(current, 0), count - 1) + delta + count) % count
}

/**
 * Scrolls the list that holds `row` just far enough for the whole row to show, and for the
 * group label right above it when it is the first of its group. A row in a part of the
 * panel that does not scroll (its footer) needs nothing.
 */
export function revealRow(row: HTMLElement | null | undefined) {
  const container = row?.closest<HTMLElement>(SCROLL_PARENTS)
  if (!row || !container) return
  const above = row.previousElementSibling
  const top = (
    above?.classList.contains("amby-block-panel-group") ? above : row
  ).getBoundingClientRect().top
  const bottom = row.getBoundingClientRect().bottom
  const view = container.getBoundingClientRect()
  const style = getComputedStyle(container)
  const edgeTop = view.top + (parseFloat(style.paddingTop) || 0)
  const edgeBottom = view.bottom - (parseFloat(style.paddingBottom) || 0)
  if (top < edgeTop) container.scrollTop -= edgeTop - top
  else if (bottom > edgeBottom) container.scrollTop += bottom - edgeBottom
}

/** Marks the row the keyboard is on (and only that one) for the style in `app.css`. */
export function markActiveRow(rows: ArrayLike<HTMLElement>, active: number) {
  for (let index = 0; index < rows.length; index++) {
    if (index === active) rows[index].setAttribute("data-kbd-active", "true")
    else rows[index].removeAttribute("data-kbd-active")
  }
}

/**
 * Whether a mouse move is the pointer really moving. When the arrow keys scroll a list, the
 * row that arrives under a resting pointer raises `mouseenter` (and some engines a
 * `mousemove` with the same coordinates): taking that for the person's choice made the
 * selection jump away from the row the keys had just moved to.
 */
export function pointerReallyMoved(
  last: { current: { x: number; y: number } | null },
  event: { clientX: number; clientY: number },
): boolean {
  const moved =
    !last.current || last.current.x !== event.clientX || last.current.y !== event.clientY
  last.current = { x: event.clientX, y: event.clientY }
  return moved
}

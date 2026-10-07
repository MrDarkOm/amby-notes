import type { EditorView } from "@tiptap/pm/view"

/**
 * The start or the end of the text line nearest, by height, to a point in the empty
 * page around the note (the margins, the gaps beside columns): the start when the
 * point is left of the line, the end otherwise. Inside a row of columns the nearest
 * column wins, so the empty page right of the last column belongs to it. Null when
 * that line has no text to put a cursor in (a database block).
 */
export function nearestLinePos(view: EditorView, y: number, x: number): number | null {
  let scope: Element = view.dom
  let bestGap = Infinity
  view.dom.querySelectorAll(".amby-column").forEach((column) => {
    const rect = column.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) return
    const gap = Math.max(rect.left - x, x - rect.right, 0)
    if (gap < bestGap) {
      bestGap = gap
      scope = column.querySelector(":scope > .amby-column-content") ?? column
    }
  })

  let nearest: Element | null = null
  let nearestDistance = Infinity
  for (const child of Array.from(scope.children)) {
    const rect = child.getBoundingClientRect()
    if (rect.height <= 0) continue
    const distance = Math.max(rect.top - y, y - rect.bottom, 0)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = child
    }
  }
  if (!nearest) return null
  try {
    const leftOfLine = x < nearest.getBoundingClientRect().left
    const pos = view.posAtDOM(nearest, leftOfLine ? 0 : nearest.childNodes.length)
    return view.state.doc.resolve(pos).parent.inlineContent ? pos : null
  } catch {
    return null
  }
}

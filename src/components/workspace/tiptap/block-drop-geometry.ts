import type { EditorView } from "@tiptap/pm/view"

/** One insertion slot has one coordinate, from either adjacent block. */
export function blockInsertionLineTop(
  view: EditorView,
  targetPos: number,
  rect: DOMRect,
  before: boolean,
): number {
  const $target = view.state.doc.resolve(targetPos)
  const parent = $target.parent
  const index = $target.index()
  const target = view.state.doc.nodeAt(targetPos)
  if (before && index > 0) {
    const previous = view.nodeDOM(targetPos - parent.child(index - 1).nodeSize)
    if (previous instanceof HTMLElement)
      return (previous.getBoundingClientRect().bottom + rect.top) / 2
  } else if (!before && target && index + 1 < parent.childCount) {
    const next = view.nodeDOM(targetPos + target.nodeSize)
    if (next instanceof HTMLElement) return (rect.bottom + next.getBoundingClientRect().top) / 2
  }
  return before ? rect.top : rect.bottom
}

/** Visible content edges, rather than the full-width paragraph's empty padding. */
export function blockContentRect(element: HTMLElement): DOMRect {
  const row = element.getBoundingClientRect()
  const rects: DOMRect[] = []
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const text = walker.currentNode
    if (!text.textContent?.trim()) continue
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(text)
    rects.push(
      ...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0),
    )
  }
  for (const media of element.querySelectorAll<HTMLElement>(
    "img:not(.ProseMirror-separator), video, canvas, table, pre, hr",
  )) {
    const rect = media.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) rects.push(rect)
  }
  if (!rects.length) return row
  const left = Math.min(...rects.map((rect) => rect.left))
  const right = Math.max(...rects.map((rect) => rect.right))
  return new DOMRect(left, row.top, right - left, row.height)
}

/** Every point outside the visible content belongs to that side of the row. */
export function blockSideAtPoint(rect: DOMRect, x: number, y: number): "left" | "right" | null {
  if (y < rect.top || y > rect.bottom) return null
  return x < rect.left ? "left" : x > rect.right ? "right" : null
}

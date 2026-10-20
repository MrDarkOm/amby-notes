import type { EditorView } from "@tiptap/pm/view"

function collectTextNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent?.closest("[contenteditable='false']")) {
        return NodeFilter.FILTER_REJECT
      }
      return (node.nodeValue?.length ?? 0) > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  let current = walker.nextNode()
  while (current) {
    nodes.push(current as Text)
    current = walker.nextNode()
  }
  return nodes
}

function posInElementAtPoint(
  view: EditorView,
  element: Element,
  x: number,
  y: number,
): number | null {
  const textNodes = collectTextNodes(element)
  if (textNodes.length > 0 && typeof document.createRange === "function") {
    const range = document.createRange()
    let bestLineRect: DOMRect | null = null
    let bestLineDist = Infinity

    for (const textNode of textNodes) {
      range.selectNodeContents(textNode)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i]
        if (rect.height <= 0 || rect.width <= 0) continue
        const vDist = Math.max(rect.top - y, y - rect.bottom, 0)
        if (vDist < bestLineDist) {
          bestLineDist = vDist
          bestLineRect = rect
        }
      }
    }

    if (bestLineRect) {
      const lineCenterY = (bestLineRect.top + bestLineRect.bottom) / 2
      const lineTol = Math.max((bestLineRect.bottom - bestLineRect.top) * 0.65, 6)

      let bestNode: Text | null = null
      let bestOffset = 0
      let bestDx = Infinity

      for (const textNode of textNodes) {
        range.selectNodeContents(textNode)
        const nodeRect = range.getBoundingClientRect()
        if (nodeRect.bottom < lineCenterY - lineTol || nodeRect.top > lineCenterY + lineTol) {
          continue
        }
        const len = textNode.nodeValue?.length ?? 0
        for (let i = 0; i < len; i++) {
          range.setStart(textNode, i)
          range.setEnd(textNode, i + 1)
          const cr = range.getBoundingClientRect()
          if (cr.height <= 0 && cr.width <= 0) continue
          const cy = (cr.top + cr.bottom) / 2
          if (Math.abs(cy - lineCenterY) > lineTol) continue
          const dx = x < cr.left ? cr.left - x : x > cr.right ? x - cr.right : 0
          const offset = x >= (cr.left + cr.right) / 2 ? i + 1 : i
          if (dx < bestDx) {
            bestDx = dx
            bestNode = textNode
            bestOffset = offset
            if (dx === 0) break
          }
        }
        if (bestDx === 0) break
      }

      if (bestNode) {
        const pos = view.posAtDOM(bestNode, bestOffset)
        if (view.state.doc.resolve(pos).parent.inlineContent) {
          return pos
        }
      }
    }
  }

  const nearestRect = element.getBoundingClientRect()
  const leftOfLine = x < nearestRect.left
  const pos = view.posAtDOM(element, leftOfLine ? 0 : element.childNodes.length)
  return view.state.doc.resolve(pos).parent.inlineContent ? pos : null
}

/**
 * Returns true when a click inside a textblock landed in the vertical inter-line gap
 * (top/bottom half-leading or space between wrapped lines) where WebKit's native
 * caretRangeFromPoint snaps the caret to the start or end of the line instead of `x`.
 */
export function isClickInInterlineGap(
  view: EditorView,
  target: HTMLElement,
  x: number,
  y: number,
): boolean {
  if (
    target.closest(
      "a, button, input, textarea, select, label, [contenteditable='false'], .amby-node-view",
    )
  ) {
    return false
  }
  const block = target.closest("p, h1, h2, h3, h4, h5, h6")
  if (!block || !view.dom.contains(block)) return false

  const textNodes = collectTextNodes(block)
  if (textNodes.length === 0 || typeof document.createRange !== "function") return false

  const range = document.createRange()
  const lineRects: DOMRect[] = []
  for (const textNode of textNodes) {
    range.selectNodeContents(textNode)
    const rects = range.getClientRects()
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      if (r.height > 0 && r.width > 0) lineRects.push(r)
    }
  }
  if (lineRects.length === 0) return false

  const hittingGlyphVertically = lineRects.some((r) => y >= r.top + 2 && y <= r.bottom - 2)
  if (!hittingGlyphVertically) return true

  // Even if `y` is near the top/bottom edge of the glyph box, check whether WebKit
  // snapped the caret to the very start or end of the line far away from `x`.
  const matchingLine = lineRects.find((r) => y >= r.top - 2 && y <= r.bottom + 2)
  if (matchingLine && x >= matchingLine.left + 12 && x <= matchingLine.right - 12) {
    try {
      const caretCoords = view.coordsAtPos(view.state.selection.from)
      if (Math.abs(caretCoords.left - x) > 24) {
        return true
      }
    } catch {
      // Ignore coordsAtPos errors
    }
  }

  return false
}

/**
 * The character position on the text line nearest, by height, to a point in the empty
 * page around the note (the margins, the gaps between paragraphs, the gaps beside
 * columns): projects `x` onto the nearest visual line when within the line's span, or
 * picks the start/end of that line when outside. Null when that block has no inline
 * text to put a cursor in (e.g. a database block).
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
    return posInElementAtPoint(view, nearest, x, y)
  } catch {
    return null
  }
}

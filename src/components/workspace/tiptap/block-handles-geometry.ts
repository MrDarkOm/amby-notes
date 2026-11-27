import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model"

export const HANDLE_APPEAR_DELAY_S = 0.3

export const DRAGGABLE_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "taskItem",
  "callout",
  "horizontalRule",
  "image",
  "table",
  "ambyBlock",
])

export function findDraggableAncestor(
  $pos: ResolvedPos,
): { pos: number; depth: number; node: PMNode } | null {
  let fallback: { pos: number; depth: number; node: PMNode } | null = null
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    if (DRAGGABLE_TYPES.has(node.type.name)) {
      const found = { pos: $pos.before(d), depth: d, node }
      // Callouts contain paragraphs. Their controls belong to the visual
      // Callout container, never to a nested paragraph above it.
      if (
        node.type.name === "callout" ||
        node.type.name === "listItem" ||
        node.type.name === "taskItem"
      )
        return found
      if (!fallback) fallback = found
    }
  }
  if (fallback) return fallback
  if ($pos.depth === 0 && $pos.nodeAfter && DRAGGABLE_TYPES.has($pos.nodeAfter.type.name)) {
    return { pos: $pos.pos, depth: 1, node: $pos.nodeAfter }
  }
  return null
}

/**
 * Draggable block under a `posAtCoords` result. A block atom (a database block)
 * reports its own position as `inside`; `pos` is only the edge before or after it,
 * and resolving that edge would hand the handle to the neighbouring block.
 */
export function findDraggableAtCoords(
  doc: PMNode,
  hit: { pos: number; inside: number },
): { pos: number; depth: number; node: PMNode } | null {
  if (hit.inside >= 0) {
    const node = doc.nodeAt(hit.inside)
    if (node?.isBlock && node.isAtom && DRAGGABLE_TYPES.has(node.type.name)) {
      return { pos: hit.inside, depth: doc.resolve(hit.inside).depth + 1, node }
    }
  }
  const safe = Math.min(Math.max(hit.pos, 0), Math.max(0, doc.content.size - 1))
  return findDraggableAncestor(doc.resolve(safe))
}

export function findScrollAncestor(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const oy = window.getComputedStyle(node).overflowY
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

export interface HandleState {
  visible: boolean
  mode: "block" | "insert"
  nodePos: number
  nodeType: string
  insertPos: number
}

export interface HoverTarget {
  mode: "block" | "insert"
  nodePos: number
  nodeType: string
  insertPos?: number
  beforePos?: number
  afterPos?: number
}

export interface DragRowTarget {
  pos: number
  depth: number
  node: PMNode
  element: HTMLElement
  rect: DOMRect
  contentRect: DOMRect
}

export interface ColumnGeometry {
  /** The last column of its set: the empty page to its right still belongs to it. */
  isLast: boolean
  /** The first column of its set: so does the empty page to its left. */
  isFirst: boolean
  columnRect: DOMRect
  contentRect: DOMRect
  blocks: Array<{ element: HTMLElement; rect: DOMRect }>
}

export const HANDLE_WIDTH = 22
export const BUTTON_H = 22
export const GUTTER_GAP = 12
// The mouse target is wider than the visible button so the affordance can be
// discovered before the cursor reaches the text column.
export const GUTTER_HIT_SLOP = 48
// A column's handle sits left of its content, outside the column box; the hover zone
// must cover the whole handle and the way to it.
export const COLUMN_GUTTER = HANDLE_WIDTH + 18

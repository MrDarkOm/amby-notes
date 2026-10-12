import type { DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { generateFractionalIndex } from "@/lib/storage/fractional-index"

export interface TextNode {
  noteId: string
  title: string
  levelId: string | null
  parentId: string | null
  orderKey: string | null
  revision: string
  children: TextNode[]
}

type PropertyIds = Pick<ProjectTextSummary["properties"], "level" | "parent" | "order">

function parse(valuesJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(valuesJson)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function field(values: Record<string, unknown>, id: string | null): Record<string, unknown> | null {
  const value = id ? values[id] : null
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/** Bytewise, as the contract says; a page without a key comes after those with one. */
function compareNodes(a: TextNode, b: TextNode): number {
  if (a.orderKey !== b.orderKey) {
    if (a.orderKey === null) return 1
    if (b.orderKey === null) return -1
    return a.orderKey < b.orderKey ? -1 : 1
  }
  return a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0
}

/**
 * The text of a story as a tree. A page whose parent is gone, or that sits in a loop made by an
 * outside edit, is shown at the top instead of being dropped: the tree must survive the files.
 */
export function buildTextTree(rows: DatabaseRow[], properties: PropertyIds): TextNode[] {
  const nodes = new Map<string, TextNode>()
  for (const row of rows) {
    const values = parse(row.valuesJson)
    const level = field(values, properties.level)?.optionId
    const parent = field(values, properties.parent)?.targetNoteIds
    const order = field(values, properties.order)?.value
    nodes.set(row.noteId, {
      noteId: row.noteId,
      title: row.title,
      levelId: typeof level === "string" ? level : null,
      parentId: Array.isArray(parent) && typeof parent[0] === "string" ? parent[0] : null,
      orderKey: typeof order === "string" && order ? order : null,
      revision: row.rowRevision,
      children: [],
    })
  }
  const inLoop = (start: TextNode): boolean => {
    const seen = new Set<string>([start.noteId])
    let current = start.parentId ? nodes.get(start.parentId) : undefined
    while (current) {
      if (seen.has(current.noteId)) return true
      seen.add(current.noteId)
      current = current.parentId ? nodes.get(current.parentId) : undefined
    }
    return false
  }
  const roots: TextNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent && parent !== node && !inLoop(node)) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: TextNode[]) => {
    list.sort(compareNodes)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

export function findNode(nodes: TextNode[], noteId: string): TextNode | null {
  for (const node of nodes) {
    if (node.noteId === noteId) return node
    const inner = findNode(node.children, noteId)
    if (inner) return inner
  }
  return null
}

/** Every page on one level, wherever it sits, each with the pages below it. In tree order. */
export function nodesAtLevel(roots: TextNode[], levelId: string): TextNode[] {
  const found: TextNode[] = []
  const visit = (nodes: TextNode[]) => {
    for (const node of nodes) {
      if (node.levelId === levelId) found.push(node)
      visit(node.children)
    }
  }
  visit(roots)
  return found
}

/** The IDs of every page below a page, at any depth: what deleting it would take with it. */
export function descendantIds(node: TextNode): string[] {
  return node.children.flatMap((child) => [child.noteId, ...descendantIds(child)])
}

function isDescendant(node: TextNode, noteId: string): boolean {
  return node.children.some((child) => child.noteId === noteId || isDescendant(child, noteId))
}

/** The position of a level in the work, deepest last; `null` for a level the work does not list. */
export function levelIndex(levels: { id: string }[], levelId: string | null): number | null {
  if (!levelId) return null
  const index = levels.findIndex((level) => level.id === levelId)
  return index === -1 ? null : index
}

/** The level a page added under `parent` starts at: one deeper, or the top one at the root. */
export function defaultLevelId(levels: { id: string }[], parent: TextNode | null): string | null {
  if (levels.length === 0) return null
  if (!parent) return levels[0].id
  const index = levelIndex(levels, parent.levelId)
  return levels[Math.min(index === null ? 0 : index + 1, levels.length - 1)].id
}

/** The key that puts a page last among the children of `parent` (or the roots). */
export function lastOrderKey(siblings: TextNode[]): string {
  const keys = siblings.map((s) => s.orderKey).filter((k): k is string => k !== null)
  return generateFractionalIndex(keys.length ? keys[keys.length - 1] : null, null)
}

export type DropZone = "before" | "after" | "inside"

export interface MovePlan {
  newParentId: string | null
  orderKey: string
}

/**
 * Where a dragged page goes when dropped on `target`, or `null` when it cannot: onto itself, into
 * its own descendants, or under a page that is not on a shallower level than the dragged one.
 * The backend checks the same rules; asking first keeps a refusal off the user's screen.
 */
export function planMove(
  roots: TextNode[],
  levels: { id: string }[],
  draggedId: string,
  targetId: string,
  zone: DropZone,
): MovePlan | null {
  const dragged = findNode(roots, draggedId)
  const target = findNode(roots, targetId)
  if (!dragged || !target || dragged === target) return null
  if (isDescendant(dragged, targetId)) return null

  const parentOf = (node: TextNode) => (node.parentId ? findNode(roots, node.parentId) : null)
  const newParent = zone === "inside" ? target : parentOf(target)
  if (newParent) {
    const parentLevel = levelIndex(levels, newParent.levelId)
    const draggedLevel = levelIndex(levels, dragged.levelId)
    if (parentLevel !== null && draggedLevel !== null && parentLevel >= draggedLevel) return null
  }
  const siblings = (newParent ? newParent.children : roots).filter((n) => n !== dragged)
  let index: number
  if (zone === "inside") index = siblings.length
  else {
    const at = siblings.indexOf(target)
    index = zone === "before" ? at : at + 1
  }
  const before = index > 0 ? siblings[index - 1].orderKey : null
  const after = index < siblings.length ? siblings[index].orderKey : null
  return {
    newParentId: newParent ? newParent.noteId : null,
    orderKey: generateFractionalIndex(before, after),
  }
}

import type { TreeItem } from "@/lib/storage"

export type TreeSortKey = "manual" | "name" | "created" | "modified"
export type TreeSortDirection = "asc" | "desc"
export type ManualTreeOrder = Record<string, string[]>
export type TreeReorderPosition = "before" | "after" | "end"

const ROOT_ORDER_KEY = "__amby_root__"

function orderKey(parentId: string | null): string {
  return parentId ?? ROOT_ORDER_KEY
}

/** Apply the persisted sibling order without changing the order of new items. */
export function applyManualTreeOrder(
  items: TreeItem[],
  order: ManualTreeOrder,
  parentId: string | null = null,
): TreeItem[] {
  const withChildren = items.map((item) =>
    item.children
      ? { ...item, children: applyManualTreeOrder(item.children, order, item.id) }
      : item,
  )
  const preferredIds = order[orderKey(parentId)] ?? []
  if (preferredIds.length === 0) return withChildren

  const ranks = new Map(preferredIds.map((id, index) => [id, index]))
  return withChildren
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        (ranks.get(left.item.id) ?? preferredIds.length + left.index) -
        (ranks.get(right.item.id) ?? preferredIds.length + right.index),
    )
    .map(({ item }) => item)
}

/** Capture the current sibling order so it can be restored after a refresh. */
export function collectManualTreeOrder(items: TreeItem[]): ManualTreeOrder {
  const order: ManualTreeOrder = {}
  const visit = (siblings: TreeItem[], parentId: string | null) => {
    order[orderKey(parentId)] = siblings.map((item) => item.id)
    for (const item of siblings) {
      if (item.children) visit(item.children, item.id)
    }
  }
  visit(items, null)
  return order
}

function findParentId(
  items: TreeItem[],
  targetId: string,
  parentId: string | null = null,
): string | null | undefined {
  for (const item of items) {
    if (item.id === targetId) return parentId
    if (item.children) {
      const found = findParentId(item.children, targetId, item.id)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function findItem(items: TreeItem[], targetId: string): TreeItem | undefined {
  for (const item of items) {
    if (item.id === targetId) return item
    if (item.children) {
      const found = findItem(item.children, targetId)
      if (found) return found
    }
  }
  return undefined
}

function replaceSiblings(
  items: TreeItem[],
  parentId: string | null,
  siblings: TreeItem[],
): TreeItem[] {
  if (parentId === null) return siblings
  return items.map((item) => {
    if (item.id === parentId) return { ...item, children: siblings }
    return item.children
      ? { ...item, children: replaceSiblings(item.children, parentId, siblings) }
      : item
  })
}

/** Reorder selected siblings without changing their filesystem location. */
export function reorderTreeItems(
  items: TreeItem[],
  sourceIds: string[],
  targetId: string | null,
  position: TreeReorderPosition,
): TreeItem[] {
  const uniqueSourceIds = [...new Set(sourceIds)]
  if (uniqueSourceIds.length === 0 || (targetId && uniqueSourceIds.includes(targetId))) return items

  const sourceParentId = findParentId(items, uniqueSourceIds[0] ?? "")
  if (sourceParentId === undefined) return items
  if (
    uniqueSourceIds.some((id) => findParentId(items, id) !== sourceParentId) ||
    (targetId !== null && findParentId(items, targetId) !== sourceParentId) ||
    (targetId === null && sourceParentId !== null)
  ) {
    return items
  }

  const siblings = sourceParentId === null ? items : findItem(items, sourceParentId)?.children
  if (!siblings) return items
  const sourceSet = new Set(uniqueSourceIds)
  const moved = siblings.filter((item) => sourceSet.has(item.id))
  if (moved.length === 0) return items

  const remaining = siblings.filter((item) => !sourceSet.has(item.id))
  const targetIndex =
    targetId === null ? remaining.length : remaining.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return items
  const insertAt =
    targetId === null || position === "end"
      ? remaining.length
      : position === "after"
        ? targetIndex + 1
        : targetIndex
  const reordered = [...remaining.slice(0, insertAt), ...moved, ...remaining.slice(insertAt)]
  return replaceSiblings(items, sourceParentId, reordered)
}

/**
 * Sort every tree level while keeping real folders above all document types.
 * Notes with children are still notes and therefore share the same sort group
 * as standalone notes and canvases.
 */
export function sortTreeItems(
  items: TreeItem[],
  key: TreeSortKey,
  direction: TreeSortDirection,
  manualOrder: ManualTreeOrder = {},
): TreeItem[] {
  if (key === "manual") return applyManualTreeOrder(items, manualOrder)
  const multiplier = direction === "asc" ? 1 : -1

  return items
    .map((item) => ({
      ...item,
      children: item.children ? sortTreeItems(item.children, key, direction) : item.children,
    }))
    .sort((left, right) => {
      const folderRank = (item: TreeItem) => (item.type === "folder" ? 0 : 1)
      const folderResult = folderRank(left) - folderRank(right)
      if (folderResult) return folderResult

      const result =
        key === "name"
          ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
          : (left[key] ?? 0) - (right[key] ?? 0)

      return (
        result * multiplier ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      )
    })
}

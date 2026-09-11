import type { TreeItem } from "@/lib/storage"

export type TreeSortKey = "name" | "created" | "modified"
export type TreeSortDirection = "asc" | "desc"

/**
 * Sort every tree level while keeping real folders above all document types.
 * Notes with children are still notes and therefore share the same sort group
 * as standalone notes and canvases.
 */
export function sortTreeItems(
  items: TreeItem[],
  key: TreeSortKey,
  direction: TreeSortDirection,
): TreeItem[] {
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

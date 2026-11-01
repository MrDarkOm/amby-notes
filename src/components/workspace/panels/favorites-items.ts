import type { TreeItem } from "@/lib/storage"

/** Bookmarked notes at any depth of the tree; folders are never listed. */
export function collectFavoriteItems(items: TreeItem[], favorites: Set<string> | undefined) {
  const result: TreeItem[] = []
  if (!favorites || favorites.size === 0) return result
  const walk = (list: TreeItem[]) => {
    for (const item of list) {
      if (item.type !== "folder" && favorites.has(item.id)) result.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return result
}

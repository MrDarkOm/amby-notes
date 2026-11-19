import type { TreeItem } from "@/lib/storage"

/** Bookmarked items (notes, folders, sketches, databases) at any depth of the tree. */
export function collectFavoriteItems(items: TreeItem[], favorites: Set<string> | undefined) {
  const result: TreeItem[] = []
  if (!favorites || favorites.size === 0) return result
  const walk = (list: TreeItem[]) => {
    for (const item of list) {
      if (favorites.has(item.id)) result.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return result
}

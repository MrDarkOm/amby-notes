import type { TreeItem } from "./sidebar-tree"
import type { TabTarget } from "./use-tabs-store"
import { findTreeItem } from "./workspace-tree-utils"

export function treeItemTabTarget(item: TreeItem): TabTarget {
  return {
    kind: item.type === "file" ? "document" : item.type,
    fileId: item.type === "canvas" || item.type === "sketch" ? item.path : item.id,
    title: item.name,
  }
}

/** Canvas and sketch tabs keep paths; tree entries may prefix their IDs with `canvas:`, `sketch:`, or `database:`.
 * Also supports matching by relative paths or stems (e.g. from Excalidraw note links or wikilinks).
 */
export function findTabTreeItem(
  items: TreeItem[],
  fileId: string,
  vault?: string | null,
): TreeItem | null {
  const direct =
    findTreeItem(items, fileId) ??
    findTreeItem(items, `canvas:${fileId}`) ??
    findTreeItem(items, `sketch:${fileId}`) ??
    findTreeItem(items, `database:${fileId}`)
  if (direct) return direct

  // Check if fileId matches a note by relative path, stem, or name
  const normalizedTarget = fileId.replace(/\\/g, "/").replace(/^\/+/u, "")
  const targetWithoutExt = normalizedTarget.replace(/\.md$/i, "")
  function walk(list: TreeItem[]): TreeItem | null {
    for (const item of list) {
      if (item.path) {
        const itemNormalized = item.path.replace(/\\/g, "/")
        const itemWithoutExt = itemNormalized.replace(/\.md$/i, "")
        if (
          itemNormalized.endsWith("/" + normalizedTarget) ||
          itemNormalized === normalizedTarget ||
          itemWithoutExt.endsWith("/" + targetWithoutExt) ||
          itemWithoutExt === targetWithoutExt ||
          (vault && itemNormalized === `${vault.replace(/\\/g, "/")}/${normalizedTarget}`)
        ) {
          return item
        }
      }
      if (
        item.type === "file" &&
        (item.name === normalizedTarget || item.name.replace(/\.md$/i, "") === targetWithoutExt)
      ) {
        return item
      }
      if (item.children) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(items)
}

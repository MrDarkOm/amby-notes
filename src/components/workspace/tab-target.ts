import type { TreeItem } from "./sidebar-tree"
import type { TabTarget } from "./use-tabs-store"
import { findTreeItem } from "./workspace-tree-utils"

export function treeItemTabTarget(item: TreeItem): TabTarget {
  return {
    kind: item.type === "file" ? "document" : item.type,
    fileId: item.type === "canvas" ? item.path : item.id,
    title: item.name,
  }
}

/** Canvas tabs keep paths; tree entries may prefix their IDs with `canvas:`. */
export function findTabTreeItem(items: TreeItem[], fileId: string): TreeItem | null {
  return findTreeItem(items, fileId) ?? findTreeItem(items, `canvas:${fileId}`)
}

import type { TreeItem } from "./types"

export const WEB_VAULT = "web-vault"
export const FILE_PREFIX = "amby:file:"
export const TREE_KEY = "amby:tree"

/** Tree traversal shared by the web storage adapter's note and search ports. */
export function flattenWebNotes(items: TreeItem[]): TreeItem[] {
  const notes: TreeItem[] = []
  for (const item of items) {
    if (item.type === "file") notes.push(item)
    if (item.children) notes.push(...flattenWebNotes(item.children))
  }
  return notes
}

import type { TreeItem } from "./tree/tree-types"

/** The kinds of file the tree can be narrowed to; folders are never a choice, they follow. */
export type TreeTypeKind = "file" | "database" | "canvas" | "sketch"

export const TREE_TYPE_KINDS: readonly TreeTypeKind[] = ["file", "database", "canvas", "sketch"]

export function isTreeTypeKind(value: unknown): value is TreeTypeKind {
  return TREE_TYPE_KINDS.some((kind) => kind === value)
}

/**
 * The tree with only the chosen kinds of file. Folders stay as the way to reach them, so a folder
 * appears only when something below it matches, and an empty one disappears. A container that is
 * not itself chosen (a database holding notes, when only notes are chosen) stays for the same
 * reason. No kinds chosen means no filter: the same array comes back.
 */
export function filterTreeByType(items: TreeItem[], kinds: ReadonlySet<TreeTypeKind>): TreeItem[] {
  if (kinds.size === 0) return items
  const walk = (list: TreeItem[]): TreeItem[] =>
    list.flatMap((item) => {
      const children = item.children ? walk(item.children) : undefined
      const chosen = item.type !== "folder" && isTreeTypeKind(item.type) && kinds.has(item.type)
      if (chosen) return [{ ...item, children }]
      return children && children.length > 0 ? [{ ...item, children }] : []
    })
  return walk(items)
}

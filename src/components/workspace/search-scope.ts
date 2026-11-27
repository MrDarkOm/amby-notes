import type { TreeItem } from "./sidebar-tree"

/** A folder a search can be narrowed to. */
export interface SearchScope {
  id: string
  name: string
  /** The folders above it, "A › B"; empty for a folder at the top of the vault. */
  path: string
  /** Everything inside it that is not a folder, at any depth. */
  itemCount: number
  /** Ids and paths of every item inside the folder, at any depth. */
  memberIds: ReadonlySet<string>
}

function collectMembers(items: TreeItem[] | undefined, into: Set<string>) {
  for (const item of items ?? []) {
    into.add(item.id)
    if (item.path) into.add(item.path)
    collectMembers(item.children, into)
  }
}

function countItems(items: TreeItem[] | undefined): number {
  let count = 0
  for (const item of items ?? []) count += 1 + countItems(item.children)
  return count
}

function countEntries(items: TreeItem[] | undefined): number {
  let count = 0
  for (const item of items ?? []) {
    if (item.type !== "folder") count += 1
    count += countEntries(item.children)
  }
  return count
}

function toScope(folder: TreeItem, parents: TreeItem[]): SearchScope {
  const memberIds = new Set<string>()
  collectMembers(folder.children, memberIds)
  return {
    id: folder.id,
    name: folder.name,
    path: parents.map((parent) => parent.name).join(" › "),
    itemCount: countEntries(folder.children),
    memberIds,
  }
}

/** Narrowing to a folder that holds the whole vault changes nothing, so it is not offered. */
function holdsWholeVault(folder: TreeItem, total: number) {
  return countItems(folder.children) >= total - 1
}

/**
 * The folders around the item the user is looking at, nearest first: the item itself when it
 * is a folder, then each folder above it.
 */
export function searchScopesFor(
  items: TreeItem[],
  contextId: string | null | undefined,
): SearchScope[] {
  if (!contextId) return []

  function chain(level: TreeItem[], parents: TreeItem[]): TreeItem[] | null {
    for (const item of level) {
      if (item.id === contextId || item.path === contextId) {
        return item.type === "folder" ? [...parents, item] : parents
      }
      if (item.children) {
        const found = chain(item.children, item.type === "folder" ? [...parents, item] : parents)
        if (found) return found
      }
    }
    return null
  }

  const total = countItems(items)
  const folders = chain(items, []) ?? []
  return folders
    .map((folder, index) => toScope(folder, folders.slice(0, index)))
    .filter((_, index) => !holdsWholeVault(folders[index]!, total))
    .reverse()
}

/** The folders at the top of the vault, in tree order. */
export function topLevelSearchScopes(items: TreeItem[]): SearchScope[] {
  const total = countItems(items)
  return items
    .filter((item) => item.type === "folder" && !holdsWholeVault(item, total))
    .map((folder) => toScope(folder, []))
}

export function isInSearchScope(scope: SearchScope, note: { id: string; path: string }) {
  return scope.memberIds.has(note.id) || scope.memberIds.has(note.path)
}

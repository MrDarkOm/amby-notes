// Pure transformation helpers extracted from workspace.tsx so they can be
// unit-tested without React or Tauri imports.
//
// These sit between the raw FsMutationResult / SessionFile shapes and the
// zustand stores — they compute *what* to change; the component applies it.

import type { FsMutationResult, PathChange } from "@/lib/storage"
import type { SessionFile } from "./app-config"
import type { TreeItem } from "./sidebar-tree"

// ── Filesystem mutation planning ────────────────────────────────────────────

/**
 * Remap a single stored path through the pathChanges list.
 * Returns the new path if a matching change exists, otherwise the original.
 */
export function remapPath(path: string, changes: PathChange[]): string {
  const normPath = path.replace(/\\/g, "/")
  const exact = changes.find((c) => c.oldPath && c.oldPath.replace(/\\/g, "/") === normPath)
  if (exact?.newPath) return exact.newPath.replace(/\\/g, "/")
  for (const change of changes) {
    if (!change.oldPath || !change.newPath) continue
    const normOld = change.oldPath.replace(/\\/g, "/").replace(/\/+$/, "")
    const normNew = change.newPath.replace(/\\/g, "/").replace(/\/+$/, "")
    if (normOld && normPath.startsWith(`${normOld}/`)) {
      const tail = normPath.slice(normOld.length)
      return `${normNew}${tail}`
    }
  }
  return path
}

/**
 * Derive the deleted-id set and a pure remap function from a FsMutationResult.
 *
 * Callers use these two values to update each store independently:
 *   const { deletedIds, remapFn, hasChanges } = planMutation(result)
 *   if (hasChanges) {
 *     docStore.applyMutation(deletedIds, remapFn)
 *     viewStore.applyMutation(deletedIds, remapFn)
 *     setTabs(filterDeletedTabs(tabs, deletedIds))
 *   }
 */
export function planMutation(result: FsMutationResult): {
  deletedIds: string[]
  remapFn: (path: string) => string
  hasChanges: boolean
} {
  // Only remap entries where both old and new path are non-empty strings.
  const changes = result.pathChanges.filter((c) => c.oldPath && c.newPath)
  // Prefer deletedIds (ULID-keyed) over deletedPaths (legacy path-keyed).
  const deleted = new Set(result.deletedIds ?? result.deletedPaths)

  return {
    deletedIds: [...deleted],
    remapFn: (path: string) => remapPath(path, changes),
    hasChanges: changes.length > 0 || deleted.size > 0,
  }
}

// ── Session-restore remap ───────────────────────────────────────────────────

/**
 * Remap a persisted id through the ULID migration table produced by the Rust
 * vault sync (sync.pathToId). Falls back to the original id if not remapped.
 */
export function remapStoredId(id: string, pathToId: Record<string, string>): string {
  return pathToId[id] ?? id
}

/**
 * Apply the pathToId remap table to a full persisted session, filtering out
 * any ids that no longer exist in the current vault tree (allIds).
 *
 * Returns plain data; the caller writes it into state / stores.
 */
export function applySessionRemap(
  session: SessionFile,
  pathToId: Record<string, string>,
  allIds: Set<string>,
  restoreSession: boolean,
): {
  icons: Record<string, string>
  favorites: string[]
  viewModes: Record<string, string>
  nestedNotesPlacements: Record<string, string>
  lockedFileIds: string[]
  tabs: { fileId: string; title: string }[]
  activeFileId: string
} {
  function remap(id: string): string {
    return pathToId[id] ?? id
  }

  // Icons: remap keys, keep all (no allIds filter — user may re-add the file).
  const icons: Record<string, string> = {}
  for (const [id, icon] of Object.entries(session.icons)) {
    icons[remap(id)] = icon
  }

  // Favorites / locked: remap + filter to existing ids.
  const favorites = session.favorites.map(remap).filter((id) => allIds.has(id))
  const lockedFileIds = session.locked.map(remap).filter((id) => allIds.has(id))

  // View modes: remap + filter.
  const viewModes: Record<string, string> = {}
  for (const [id, mode] of Object.entries(session.viewModes)) {
    const nextId = remap(id)
    if (allIds.has(nextId)) viewModes[nextId] = mode
  }

  const nestedNotesPlacements: Record<string, string> = {}
  for (const [id, placement] of Object.entries(session.nestedNotesPlacements)) {
    const nextId = remap(id)
    if (allIds.has(nextId)) nestedNotesPlacements[nextId] = placement
  }

  // Tabs: remap then filter; honour the restoreSession setting.
  const tabs = restoreSession
    ? session.tabs
        .map((e) => ({ ...e, fileId: remap(e.fileId) }))
        .filter((e) => allIds.has(e.fileId))
    : []

  // Active file id: remapped but not filtered (caller finds the tab from valid list).
  const activeFileId = remap(session.activeFileId)

  return {
    icons,
    favorites,
    viewModes,
    nestedNotesPlacements,
    lockedFileIds,
    tabs,
    activeFileId,
  }
}

// ── Tree mutation patching ──────────────────────────────────────────────────

function normalizeTreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/u, "")
}

function dirname(path: string): string | null {
  const normalized = normalizeTreePath(path)
  const slash = normalized.lastIndexOf("/")
  return slash > 0 ? normalized.slice(0, slash) : null
}

function basename(path: string): string {
  return normalizeTreePath(path).split("/").pop() ?? path
}

function displayName(path: string): string {
  return basename(path).replace(/\.(md|canvas|excalidraw)$/u, "") || basename(path)
}

function flattenTree(items: TreeItem[]): TreeItem[] {
  return items.flatMap((item) => [
    { ...item, children: undefined },
    ...(item.children ? flattenTree(item.children) : []),
  ])
}

function commonDir(paths: string[]): string | null {
  if (paths.length < 2) return null
  const dirs = paths.map(dirname)
  if (dirs.some((dir) => dir === null)) return null
  const parts = (dirs[0] ?? "").split("/")
  let shared = parts.length
  for (const dir of dirs.slice(1)) {
    const current = (dir ?? "").split("/")
    shared = Math.min(
      shared,
      current.findIndex((part, index) => part !== parts[index]),
    )
    if (shared === -1) shared = Math.min(parts.length, current.length)
  }
  const value = parts.slice(0, shared).join("/")
  return value || null
}

function treeParentPath(item: TreeItem, allItems: TreeItem[]): string | null {
  const parentDir = dirname(item.path)
  if (!parentDir) return null
  if (item.type === "file") {
    const bundleMain = `${parentDir}/${basename(parentDir)}.md`
    if (bundleMain === normalizeTreePath(item.path)) return dirname(parentDir)
    if (allItems.some((candidate) => candidate.path === bundleMain)) {
      return bundleMain
    }
  }
  return parentDir
}

function sortTree(items: TreeItem[]): TreeItem[] {
  return items
    .map((item) => ({ ...item, children: item.children ? sortTree(item.children) : item.children }))
    .sort((left, right) => {
      const typeOrder = (item: TreeItem) => (item.type === "folder" ? 0 : 1)
      return typeOrder(left) - typeOrder(right) || left.name.localeCompare(right.name)
    })
}

/**
 * Apply a filesystem mutation to the already-loaded tree. The operation never
 * reads disk: it only moves/removes existing nodes and inserts a newly indexed
 * markdown note. Complex operations without enough metadata (such as a raw
 * standalone-canvas move) deliberately keep using refreshTree at the caller.
 */
export function applyTreePatch(items: TreeItem[], result: FsMutationResult): TreeItem[] {
  const pathMap = new Map(
    result.pathChanges
      .filter((change) => change.oldPath && change.newPath)
      .map((change) => [normalizeTreePath(change.oldPath), normalizeTreePath(change.newPath)]),
  )
  const deletedIds = new Set(result.deletedIds ?? [])
  const deletedPaths = new Set(result.deletedPaths.map(normalizeTreePath))
  const absorbedCanvasPaths = new Set(
    result.primaryId
      ? result.pathChanges
          .filter(
            (change) => change.oldPath.endsWith(".canvas") && change.newPath.endsWith(".canvas"),
          )
          .map((change) => normalizeTreePath(change.oldPath))
      : [],
  )

  const flat = flattenTree(items).filter(
    (item) =>
      !deletedIds.has(item.id) &&
      !deletedPaths.has(normalizeTreePath(item.path)) &&
      !absorbedCanvasPaths.has(normalizeTreePath(item.path)),
  )

  const oldPaths = [...pathMap.keys()]
  const newPaths = [...pathMap.values()]
  const primaryPath = result.primaryPath ? normalizeTreePath(result.primaryPath) : null
  const primaryIsFolder = primaryPath !== null && !basename(primaryPath).includes(".")
  const oldFolder = commonDir(oldPaths) ?? (primaryIsFolder ? dirname(oldPaths[0] ?? "") : null)
  const newFolder = primaryIsFolder ? primaryPath : commonDir(newPaths)
  const hasMovedFolder =
    oldFolder !== null &&
    newFolder !== null &&
    primaryIsFolder &&
    primaryPath === newFolder &&
    flat.some((item) => item.type === "folder" && normalizeTreePath(item.path) === oldFolder)

  const next: TreeItem[] = flat.map((item) => {
    const oldPath = normalizeTreePath(item.path)
    const explicitPath = pathMap.get(oldPath)
    const nextPath =
      explicitPath ??
      (hasMovedFolder &&
      oldFolder &&
      newFolder &&
      (oldPath === oldFolder || oldPath.startsWith(`${oldFolder}/`))
        ? `${newFolder}${oldPath.slice(oldFolder.length)}`
        : oldPath)
    return {
      ...item,
      id:
        item.type === "folder"
          ? `folder:${nextPath}`
          : item.type === "canvas"
            ? `canvas:${nextPath}`
            : item.id,
      path: nextPath,
      name: displayName(nextPath),
      children: undefined,
    }
  })

  if (
    result.primaryId &&
    result.primaryPath &&
    !next.some((item) => item.id === result.primaryId)
  ) {
    const path = normalizeTreePath(result.primaryPath)
    next.push({ id: result.primaryId, path, name: displayName(path), type: "file", icon: "file" })
  }

  const byPath = new Map(next.map((item) => [item.path, { ...item, children: [] as TreeItem[] }]))
  const roots: TreeItem[] = []
  for (const item of byPath.values()) {
    const parentPath = treeParentPath(item, [...byPath.values()])
    const parent = parentPath ? byPath.get(parentPath) : undefined
    if (parent) parent.children!.push(item)
    else roots.push(item)
  }

  function restoreOptionalChildren(item: TreeItem): TreeItem {
    const children = item.children?.map(restoreOptionalChildren)
    return {
      ...item,
      children: children?.length ? children : item.type === "folder" ? [] : undefined,
    }
  }

  return sortTree(roots).map(restoreOptionalChildren)
}

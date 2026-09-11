// Pure transformation helpers extracted from workspace.tsx so they can be
// unit-tested without React or Tauri imports.
//
// These sit between the raw FsMutationResult / SessionFile shapes and the
// zustand stores — they compute *what* to change; the component applies it.

import type { FsMutationResult, PathChange } from "@/lib/storage"
import type { SessionFile } from "./app-config"
import type { TreeItem } from "./sidebar-tree"
import type { Tab } from "./use-tabs-store"

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
  // Keep both forms: indexed notes return stable ids while unindexed files
  // (for example canvases) may only be represented by their deleted path.
  const deleted = new Set([...(result.deletedIds ?? []), ...result.deletedPaths])

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
  contentWidths: Record<string, string>
  databaseTitleLabels: Record<string, string>
  nestedNotesPlacements: Record<string, string>
  lockedFileIds: string[]
  closedTreeIds: string[]
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
  const closedTreeIds = (session.closedTreeIds ?? []).map(remap).filter((id) => allIds.has(id))

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

  // Content width overrides use the same stable ids as the other per-page
  // settings. Database ids are not present in the note tree, so preserve them
  // while still remapping legacy path ids when available.
  const contentWidths: Record<string, string> = {}
  for (const [id, width] of Object.entries(session.contentWidths ?? {})) {
    contentWidths[remap(id)] = width
  }

  const databaseTitleLabels: Record<string, string> = {}
  for (const [id, label] of Object.entries(session.databaseTitleLabels ?? {})) {
    databaseTitleLabels[remap(id)] = label
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
    contentWidths,
    databaseTitleLabels,
    nestedNotesPlacements,
    lockedFileIds,
    closedTreeIds,
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

/**
 * Refresh labels for stable-ID tabs from the newly indexed tree. External
 * rename/move events do not produce a frontend FsMutationResult, so their tab
 * titles must converge when refreshTree receives the updated item names.
 */
export function reconcileTreeBackedTabTitles(tabs: Tab[], tree: TreeItem[]): Tab[] {
  const titlesById = new Map(flattenTree(tree).map((item) => [item.id, item.name]))
  let changed = false
  const next = tabs.map((tab) => {
    const title = titlesById.get(tab.fileId)
    if (!title || title === tab.title) return tab
    changed = true
    return { ...tab, title }
  })
  return changed ? next : tabs
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

function treeParentPath(item: TreeItem, itemsByPath: ReadonlyMap<string, TreeItem>): string | null {
  const itemPath = normalizeTreePath(item.path)
  let containerDir = dirname(itemPath)
  if (!containerDir) return null

  // A bundle main note represents its containing directory in the visual tree,
  // so its parent lives one filesystem level above that directory.
  if (item.type === "file" && itemPath === `${containerDir}/${basename(containerDir)}.md`) {
    containerDir = dirname(containerDir)
    if (!containerDir) return null
  }

  // Regular files and folders inside a bundle are children of the bundle's
  // main note, not root rows. Checking this for every item type is important:
  // folder rows were previously detached whenever a mutation rebuilt the tree.
  const bundleMain = `${containerDir}/${basename(containerDir)}.md`
  if (itemsByPath.has(bundleMain)) return bundleMain
  return itemsByPath.has(containerDir) ? containerDir : null
}

function compareTreeItems(left: TreeItem, right: TreeItem): number {
  const typeOrder = (item: TreeItem) => (item.type === "folder" ? 0 : 1)
  return typeOrder(left) - typeOrder(right) || left.name.localeCompare(right.name)
}

function sortTree(items: TreeItem[]): TreeItem[] {
  return items
    .map((item) => ({ ...item, children: item.children ? sortTree(item.children) : item.children }))
    .sort(compareTreeItems)
}

function reuseUnchangedTreeItems(previous: TreeItem[], next: TreeItem[]): TreeItem[] {
  const previousById = new Map<string, TreeItem>()
  const indexPrevious = (items: TreeItem[]) => {
    for (const item of items) {
      previousById.set(item.id, item)
      if (item.children) indexPrevious(item.children)
    }
  }
  indexPrevious(previous)

  const reconcile = (item: TreeItem): TreeItem => {
    const children = item.children?.map(reconcile)
    const candidate = previousById.get(item.id)
    const candidateChildren = candidate?.children
    const childrenMatch =
      children === undefined
        ? candidateChildren === undefined
        : candidateChildren !== undefined &&
          children.length === candidateChildren.length &&
          children.every((child, index) => child === candidateChildren[index])
    if (
      candidate &&
      candidate.path === item.path &&
      candidate.name === item.name &&
      candidate.type === item.type &&
      candidate.icon === item.icon &&
      candidate.created === item.created &&
      candidate.modified === item.modified &&
      childrenMatch
    ) {
      return candidate
    }
    return children === item.children ? item : { ...item, children }
  }

  const reconciled = next.map(reconcile)
  return reconciled.length === previous.length &&
    reconciled.every((item, index) => item === previous[index])
    ? previous
    : reconciled
}

function insertCreatedNote(items: TreeItem[], note: TreeItem): TreeItem[] {
  const notePath = normalizeTreePath(note.path)
  const parentDir = dirname(notePath)
  const bundleParentPath = parentDir ? `${parentDir}/${basename(parentDir)}.md` : null
  let inserted = false

  const visit = (list: TreeItem[]): TreeItem[] => {
    let changed = false
    const next = list.map((item) => {
      if (normalizeTreePath(item.path) === notePath) {
        inserted = true
        changed = true
        return note
      }
      if (
        !inserted &&
        parentDir &&
        (normalizeTreePath(item.path) === parentDir ||
          normalizeTreePath(item.path) === bundleParentPath)
      ) {
        inserted = true
        changed = true
        const children = item.children ?? []
        const existingIndex = children.findIndex(
          (child) => normalizeTreePath(child.path) === notePath,
        )
        const nextChildren =
          existingIndex === -1
            ? [...children, note]
            : children.map((child, index) => (index === existingIndex ? note : child))
        return { ...item, children: nextChildren.sort(compareTreeItems) }
      }
      if (!item.children) return item
      const children = visit(item.children)
      if (children === item.children) return item
      changed = true
      return { ...item, children }
    })
    return changed ? next : list
  }

  const next = visit(items)
  return inserted ? next : [...items, note].sort(compareTreeItems)
}

/**
 * Apply a filesystem mutation to the already-loaded tree. The operation never
 * reads disk: it only moves/removes existing nodes and inserts a newly indexed
 * markdown note. Complex operations without enough metadata (such as a raw
 * standalone-canvas move) deliberately keep using refreshTree at the caller.
 */
export function applyTreePatch(items: TreeItem[], result: FsMutationResult): TreeItem[] {
  const createdPaths = result.pathChanges.filter(
    (change) => !change.oldPath && Boolean(change.newPath),
  )
  const isSimpleNoteCreation =
    createdPaths.length === 1 &&
    result.pathChanges.every((change) => !change.oldPath) &&
    result.deletedPaths.length === 0 &&
    (result.deletedIds?.length ?? 0) === 0 &&
    Boolean(result.primaryPath)
  if (isSimpleNoteCreation) {
    const path = normalizeTreePath(result.primaryPath!)
    return insertCreatedNote(items, {
      // A degraded index can leave primaryId empty even though the file was
      // created successfully. Keep it visible and renameable using its path;
      // the next vault sync can replace this fallback with the stable id.
      id: result.primaryId ?? path,
      path,
      name: displayName(path),
      type: "file",
      icon: "file",
    })
  }

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
  const folderMovePrefixes = [...pathMap.entries()]
    .filter(([oldPath]) =>
      flat.some((item) => item.type === "folder" && normalizeTreePath(item.path) === oldPath),
    )
    .sort(([left], [right]) => right.length - left.length)

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
    const folderMove = folderMovePrefixes.find(
      ([folderPath]) => oldPath === folderPath || oldPath.startsWith(`${folderPath}/`),
    )
    const nextPath =
      explicitPath ??
      (folderMove ? `${folderMove[1]}${oldPath.slice(folderMove[0].length)}` : undefined) ??
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

  if (result.primaryPath) {
    const path = normalizeTreePath(result.primaryPath)
    const alreadyPresent = result.primaryId
      ? next.some((item) => item.id === result.primaryId)
      : next.some((item) => normalizeTreePath(item.path) === path)
    if (!alreadyPresent) {
      next.push({
        // A missing primary id means the index is degraded; the path remains
        // a usable temporary identity until the next vault sync.
        id: result.primaryId ?? path,
        path,
        name: displayName(path),
        type: "file",
        icon: "file",
      })
    }
  }

  const byPath = new Map(next.map((item) => [item.path, { ...item, children: [] as TreeItem[] }]))
  const roots: TreeItem[] = []
  for (const item of byPath.values()) {
    const parentPath = treeParentPath(item, byPath)
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

  return reuseUnchangedTreeItems(items, sortTree(roots).map(restoreOptionalChildren))
}

/**
 * Reparent selected rows immediately while the filesystem move is in flight.
 * Paths are intentionally left untouched: the authoritative mutation result
 * remaps them once the backend completes, while this keeps the tree stable
 * during the operation.
 */
export function moveTreeItemsOptimistically(
  items: TreeItem[],
  sourceIds: string[],
  targetId: string | null,
): TreeItem[] {
  const selected = new Set(sourceIds)
  if (selected.size === 0) return items

  const moved: TreeItem[] = []
  function extract(list: TreeItem[]): TreeItem[] {
    const remaining: TreeItem[] = []
    for (const item of list) {
      if (selected.has(item.id)) {
        moved.push(item)
        continue
      }
      if (item.children) {
        remaining.push({ ...item, children: extract(item.children) })
      } else {
        remaining.push(item)
      }
    }
    return remaining
  }

  const remaining = extract(items)
  if (moved.length === 0) return items
  if (!targetId) return [...remaining, ...moved]

  let inserted = false
  function insert(list: TreeItem[]): TreeItem[] {
    return list.map((item) => {
      if (item.id === targetId) {
        inserted = true
        return { ...item, children: [...(item.children ?? []), ...moved] }
      }
      return item.children ? { ...item, children: insert(item.children) } : item
    })
  }

  const next = insert(remaining)
  return inserted ? next : items
}

/** Insert a pending row without rebuilding unrelated branches of the tree. */
export function insertTreeItemOptimistically(
  items: TreeItem[],
  parentId: string | null,
  pendingItem: TreeItem,
): TreeItem[] {
  const insertSorted = (list: TreeItem[]) => [...list, pendingItem].sort(compareTreeItems)
  if (!parentId) return insertSorted(items)

  let inserted = false
  const visit = (list: TreeItem[]): TreeItem[] => {
    let changed = false
    const next = list.map((item) => {
      if (item.id === parentId) {
        inserted = true
        changed = true
        return { ...item, children: insertSorted(item.children ?? []) }
      }
      if (!item.children) return item
      const children = visit(item.children)
      if (children === item.children) return item
      changed = true
      return { ...item, children }
    })
    return changed ? next : list
  }

  const next = visit(items)
  return inserted ? next : items
}

export function removeTreeItem(items: TreeItem[], id: string): TreeItem[] {
  let changed = false
  const next: TreeItem[] = []
  for (const item of items) {
    if (item.id === id) {
      changed = true
      continue
    }
    if (item.children) {
      const children = removeTreeItem(item.children, id)
      if (children !== item.children) {
        changed = true
        next.push({ ...item, children })
        continue
      }
    }
    next.push(item)
  }
  return changed ? next : items
}

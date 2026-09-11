// Pure tree/path utilities extracted from workspace.tsx so they can be
// unit-tested without React or Tauri imports.

import i18n from "@/lib/i18n"
import type { TreeItem } from "./sidebar-tree"

// ── Path helpers ──────────────────────────────────────────────────────────────

export function wsPathDir(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/")
  return idx === -1 ? "" : path.slice(0, idx)
}

export function wsPathBase(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

export function wsPathStem(path: string): string {
  return wsPathBase(path).replace(/\.[^.]+$/u, "")
}

function normalizeComparablePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "")
}

function comparableName(name: string): string {
  return name.trim().toLocaleLowerCase()
}

/**
 * Pick the first free note name in a filesystem directory.
 *
 * Notes and bundle folders share the same namespace on disk, so both are
 * considered occupied. Canvas files are intentionally ignored: a note and a
 * canvas with the same stem are valid separate items.
 */
export function nextAvailableNoteName(
  items: TreeItem[],
  parentPath: string,
  baseName: string,
  reservedNames: ReadonlySet<string> = new Set(),
): string {
  const normalizedParent = normalizeComparablePath(parentPath)
  const occupied = new Set<string>([...reservedNames].map(comparableName))

  function visit(nodes: TreeItem[]) {
    for (const item of nodes) {
      const itemPath = normalizeComparablePath(item.path)
      const itemDirectory = normalizeComparablePath(wsPathDir(item.path))
      if (item.type !== "canvas" && itemDirectory === normalizedParent) {
        occupied.add(
          comparableName(item.type === "folder" ? wsPathBase(item.path) : wsPathStem(item.path)),
        )
      }
      // A bundle's main note is rendered as one tree item, but its containing
      // directory also occupies a sibling name in the parent directory.
      if (item.type === "file" && isSuperNoteItem({ path: itemPath, type: item.type })) {
        const bundleParent = normalizeComparablePath(wsPathDir(itemDirectory))
        if (bundleParent === normalizedParent)
          occupied.add(comparableName(wsPathBase(itemDirectory)))
      }
      if (item.children) visit(item.children)
    }
  }
  visit(items)

  const trimmedBase = baseName.trim()
  if (!trimmedBase) return baseName
  let candidate = trimmedBase
  let suffix = 1
  while (occupied.has(comparableName(candidate))) candidate = `${trimmedBase} ${suffix++}`
  return candidate
}

/** A supernote is the main Markdown file inside its same-named bundle folder. */
export function isSuperNoteItem(item: Pick<TreeItem, "path" | "type">): boolean {
  if (item.type !== "file") return false
  const parent = wsPathDir(item.path).replace(/[\\/]+$/u, "")
  return wsPathBase(parent) === wsPathStem(item.path)
}

/** Path of a note's canvas layer sidecar file (<dir>/<stem>.canvas). */
export function canvasLayerPath(notePath: string): string {
  const dir = wsPathDir(notePath)
  const stem = wsPathStem(notePath)
  return `${dir}/${stem}.canvas`
}

// ── Tree traversal helpers ────────────────────────────────────────────────────

/** Collect all file-type items from a recursive tree (depth-first). */
export function flattenFileItems(items: TreeItem[]): TreeItem[] {
  const files: TreeItem[] = []
  function walk(list: TreeItem[]) {
    for (const item of list) {
      if (item.type === "file") files.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return files
}

/** Collect all item ids from a recursive tree into a Set. */
export function flattenTree(items: TreeItem[]): Set<string> {
  const ids = new Set<string>()
  function walk(list: TreeItem[]) {
    for (const item of list) {
      ids.add(item.id)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return ids
}

/** Find a TreeItem by id (depth-first). Returns null if not found. */
export function findTreeItem(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item
    if (item.children) {
      const found = findTreeItem(item.children, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Return a new tree with one item replaced by the result of `updater`.
 * Does not mutate the original array.
 */
export function updateInTree(
  items: TreeItem[],
  id: string,
  updater: (item: TreeItem) => TreeItem,
): TreeItem[] {
  return items.map((item) => {
    if (item.id === id) return updater(item)
    if (item.children) return { ...item, children: updateInTree(item.children, id, updater) }
    return item
  })
}

/**
 * Return a new tree with icon overrides applied at every level.
 * If an id has an entry in `overrides`, its icon is replaced.
 */
export function applyIconOverrides(
  items: TreeItem[],
  overrides: Record<string, string>,
): TreeItem[] {
  let changed = false
  const next = items.map((item) => {
    const icon = overrides[item.id] ?? item.icon
    const children = item.children ? applyIconOverrides(item.children, overrides) : undefined
    if (icon === item.icon && children === item.children) return item
    changed = true
    return { ...item, icon, children }
  })
  return changed ? next : items
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

/** Format a Unix-timestamp (seconds) as a human-readable relative string. */
export function formatModified(ts?: number): string {
  const t = i18n.t.bind(i18n)
  if (!ts) return t("time.justNow")
  const date = new Date(ts * 1000)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return t("time.justNow")
  if (diffMins < 60) return t("time.minsAgo", { n: diffMins })
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t("time.hoursAgo", { n: diffHours })
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return t("time.yesterday")
  return t("time.daysAgo", { n: diffDays })
}

/** Generate a unique tab key (not crypto-grade; just needs to be collision-free). */
export function newTabKey(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

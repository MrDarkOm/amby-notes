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
  return items.map((item) => ({
    ...item,
    icon: overrides[item.id] ?? item.icon,
    children: item.children ? applyIconOverrides(item.children, overrides) : undefined,
  }))
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

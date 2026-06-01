// Pure transformation helpers extracted from workspace.tsx so they can be
// unit-tested without React or Tauri imports.
//
// These sit between the raw FsMutationResult / SessionFile shapes and the
// zustand stores — they compute *what* to change; the component applies it.

import type { FsMutationResult, PathChange } from "@/lib/storage"
import type { SessionFile } from "./app-config"

// ── Filesystem mutation planning ────────────────────────────────────────────

/**
 * Remap a single stored path through the pathChanges list.
 * Returns the new path if a matching change exists, otherwise the original.
 */
export function remapPath(path: string, changes: PathChange[]): string {
  const exact = changes.find((c) => c.oldPath && c.oldPath === path)
  return exact?.newPath ?? path
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

  // Tabs: remap then filter; honour the restoreSession setting.
  const tabs = restoreSession
    ? session.tabs
        .map((e) => ({ ...e, fileId: remap(e.fileId) }))
        .filter((e) => allIds.has(e.fileId))
    : []

  // Active file id: remapped but not filtered (caller finds the tab from valid list).
  const activeFileId = remap(session.activeFileId)

  return { icons, favorites, viewModes, lockedFileIds, tabs, activeFileId }
}

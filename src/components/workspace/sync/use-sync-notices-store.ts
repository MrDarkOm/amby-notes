import { create } from "zustand"

import type { VaultSyncStatus } from "@/lib/sync/sync-port"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"

export type SyncConflict = VaultSyncStatus["conflicts"][number]

/** Which side of a conflict a note is. */
export type ConflictRole = "original" | "copy"

interface SyncNoticesState {
  /** The open conflicts of the vault, as the last status said. */
  conflicts: SyncConflict[]
  /** Paths (in the vault) of notes deleted on another computer while they were open. */
  remoteDeleted: string[]
  /** Paths whose return from the archive failed: the general "deleted" strip is shown again. */
  restoreFailed: string[]
  setRestoreFailed: (path: string, failed: boolean) => void
  /** The conflict shown in the comparison, if any. */
  compareId: string | null
  setConflicts: (conflicts: SyncConflict[]) => void
  markRemoteDeleted: (path: string) => void
  clearRemoteDeleted: (path: string) => void
  openCompare: (id: string) => void
  closeCompare: () => void
}

export const useSyncNoticesStore = create<SyncNoticesState>((set) => ({
  conflicts: [],
  remoteDeleted: [],
  compareId: null,
  restoreFailed: [],
  setRestoreFailed: (path, failed) =>
    set((state) => {
      const rest = state.restoreFailed.filter((item) => item !== path)
      return { restoreFailed: failed ? [...rest, path] : rest }
    }),
  setConflicts: (conflicts) =>
    set((state) => ({
      conflicts,
      compareId: conflicts.some((item) => item.id === state.compareId) ? state.compareId : null,
    })),
  markRemoteDeleted: (path) =>
    set((state) =>
      state.remoteDeleted.includes(path)
        ? state
        : { remoteDeleted: [...state.remoteDeleted, path] },
    ),
  clearRemoteDeleted: (path) =>
    set((state) => ({
      remoteDeleted: state.remoteDeleted.filter((item) => item !== path),
      restoreFailed: state.restoreFailed.filter((item) => item !== path),
    })),
  openCompare: (id) => set({ compareId: id }),
  closeCompare: () => set({ compareId: null }),
}))

/** The conflict a note takes part in, as the main file or as the copy. */
export function conflictForPath(
  conflicts: SyncConflict[],
  vaultPath: string,
  documentPath: string,
): { conflict: SyncConflict; role: ConflictRole } | null {
  const relative = relativeToVault(documentPath, vaultPath).normalize("NFC")
  for (const conflict of conflicts) {
    if (conflict.originalPath.normalize("NFC") === relative) return { conflict, role: "original" }
    if (conflict.copyPath.normalize("NFC") === relative) return { conflict, role: "copy" }
  }
  return null
}

/** The path of a file of the vault on disk. */
export function absoluteVaultPath(vaultPath: string, relative: string): string {
  return `${vaultPath.replace(/[\\/]+$/u, "")}/${relative}`
}

import { create } from "zustand"

import type { ConflictChoice, VaultSyncStatus } from "@/lib/sync/sync-port"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import type { LimitNotice } from "./limit-notices"

export type SyncConflict = VaultSyncStatus["conflicts"][number]

/** Which side of a conflict a note is. */
export type ConflictRole = "original" | "copy"

/** What the person chose; `assembled` is a text put together from the chosen parts of both versions. */
export type OutcomeChoice = ConflictChoice | "assembled"

/**
 * What was done after a choice in the comparison (docs/notices.md, section 10: consequences are said after
 * the action). It is a card in the note when the note is open; the journal of the notification centre
 * says it too, whether the note is open or not.
 */
export interface ConflictOutcome {
  conflictId: string
  /** The path of the note in the vault, NFC. */
  path: string
  /** The name of the note, without the extension. */
  name: string
  choice: OutcomeChoice
}

interface SyncNoticesState {
  outcomes: ConflictOutcome[]
  addOutcome: (outcome: ConflictOutcome) => void
  dismissOutcome: (conflictId: string) => void
  /** The open conflicts of the vault, as the last status said. */
  conflicts: SyncConflict[]
  /** Paths (in the vault) of notes deleted on another computer while they were open. */
  remoteDeleted: string[]
  /** Paths whose return from the archive failed: the general "deleted" strip is shown again. */
  restoreFailed: string[]
  setRestoreFailed: (path: string, failed: boolean) => void
  /** The limits of the plan the last status speaks of (one per cause); the centre lets the person hide them. */
  limits: LimitNotice[]
  /** The stop of the sync that waits for the person, as the last status said. */
  stop: NonNullable<VaultSyncStatus["stop"]> | null
  /** How many files failed in the last pass. */
  itemErrors: number
  /** Takes what the notification centre needs from a status of the sync. */
  setStatusSummary: (summary: {
    limits: LimitNotice[]
    stop: NonNullable<VaultSyncStatus["stop"]> | null
    itemErrors: number
  }) => void
  /** The conflict shown in the comparison, if any. */
  compareId: string | null
  setConflicts: (conflicts: SyncConflict[]) => void
  markRemoteDeleted: (path: string) => void
  clearRemoteDeleted: (path: string) => void
  openCompare: (id: string) => void
  closeCompare: () => void
}

export const useSyncNoticesStore = create<SyncNoticesState>((set) => ({
  outcomes: [],
  addOutcome: (outcome) =>
    set((state) => ({
      outcomes: [
        ...state.outcomes.filter((item) => item.conflictId !== outcome.conflictId),
        outcome,
      ],
    })),
  dismissOutcome: (conflictId) =>
    set((state) => ({ outcomes: state.outcomes.filter((item) => item.conflictId !== conflictId) })),
  conflicts: [],
  remoteDeleted: [],
  compareId: null,
  restoreFailed: [],
  limits: [],
  stop: null,
  itemErrors: 0,
  setStatusSummary: ({ limits, stop, itemErrors }) => set({ limits, stop, itemErrors }),
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

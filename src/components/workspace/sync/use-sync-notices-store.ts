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
 * the action). Until the notification centre keeps a log (step 2), it is a card in the note when the note
 * is open (`card`) and a line in the list of conflicts, until the list is closed, when it is not (`list`).
 */
export interface ConflictOutcome {
  conflictId: string
  /** The path of the note in the vault, NFC. */
  path: string
  /** The name of the note, without the extension. */
  name: string
  choice: OutcomeChoice
  where: "card" | "list"
}

interface SyncNoticesState {
  outcomes: ConflictOutcome[]
  addOutcome: (outcome: ConflictOutcome) => void
  dismissOutcome: (conflictId: string) => void
  /** The list of conflicts is closed: what it said about the choices made is not kept. */
  clearListOutcomes: () => void
  /** The open conflicts of the vault, as the last status said. */
  conflicts: SyncConflict[]
  /** Paths (in the vault) of notes deleted on another computer while they were open. */
  remoteDeleted: string[]
  /** Paths whose return from the archive failed: the general "deleted" strip is shown again. */
  restoreFailed: string[]
  setRestoreFailed: (path: string, failed: boolean) => void
  /** The notices about the limits of the plan that are shown now (one per cause, closed ones left out). */
  limits: LimitNotice[]
  setLimits: (limits: LimitNotice[]) => void
  /** The list of conflicts beside the notices button of the dock is open. */
  conflictListOpen: boolean
  toggleConflictList: () => void
  closeConflictList: () => void
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
  clearListOutcomes: () =>
    set((state) =>
      state.outcomes.some((item) => item.where === "list")
        ? { outcomes: state.outcomes.filter((item) => item.where !== "list") }
        : state,
    ),
  conflicts: [],
  remoteDeleted: [],
  compareId: null,
  restoreFailed: [],
  limits: [],
  setLimits: (limits) => set({ limits }),
  conflictListOpen: false,
  toggleConflictList: () => {
    if (useSyncNoticesStore.getState().conflictListOpen) {
      useSyncNoticesStore.getState().closeConflictList()
    } else {
      set({ conflictListOpen: true })
    }
  },
  closeConflictList: () => {
    set({ conflictListOpen: false })
    useSyncNoticesStore.getState().clearListOutcomes()
  },
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

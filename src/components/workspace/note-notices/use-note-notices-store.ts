import { create } from "zustand"
import { subscribeRecoveryProblems } from "@/lib/recovery-drafts"

/** The two answers to an unsaved draft that was found when a note was opened. */
export interface DraftOffer {
  accept: () => void
  reject: () => void
}

interface NoteNoticesState {
  /** Notes (by document id) whose last save failed; cleared by the next successful save. */
  saveFailed: Record<string, true>
  /**
   * Notes (by document id) whose last change of a property failed, with the path of the note so the
   * notification centre can name it after its tab is gone. An event, not a state: the panel was read again,
   * so nothing waits to be written. It ends with the next successful change of a property or when the
   * person closes it (in the card or in the centre, which share the id).
   */
  propertyFailed: Record<string, { path: string }>
  setPropertyFailed: (fileId: string, failure: { path: string } | null) => void
  /**
   * Notes (by document id) whose recovery draft could not be written (`write`) or read (`read`).
   * Written by the journal itself, see the subscription below the store.
   */
  recoveryProblems: Record<string, "write" | "read">
  setRecoveryProblem: (fileId: string, problem: "write" | "read" | null) => void
  /** Unsaved drafts waiting for an answer, by document id. The note is read only until it comes. */
  draftOffers: Record<string, DraftOffer>
  /** Paths (in the vault) of open notes that came back after a deletion made here. */
  restored: string[]
  /** Paths (in the vault) of open notes where a pass merged the edits of two computers. */
  merged: string[]
  markMerged: (path: string) => void
  clearMerged: (path: string) => void
  /**
   * Notes (by document id) that are no longer open and whose last autosave failed. Their text is kept in
   * the recovery draft; the notification centre says it until the save goes through or the draft is decided.
   */
  closedSaveFailed: Record<string, { name: string; path: string }>
  setClosedSaveFailed: (fileId: string, failure: { name: string; path: string } | null) => void
  setSaveFailed: (fileId: string, failed: boolean) => void
  offerDraft: (fileId: string, offer: DraftOffer) => void
  clearDraftOffer: (fileId: string) => void
  markRestored: (path: string) => void
  clearRestored: (path: string) => void
}

/**
 * What the notices of a note need beyond the stores that already hold the rest (the external
 * conflicts of the document store, the sync notices): events that have no other home.
 */
export const useNoteNoticesStore = create<NoteNoticesState>((set) => ({
  saveFailed: {},
  propertyFailed: {},
  setPropertyFailed: (fileId, failure) =>
    set((state) => {
      const current = state.propertyFailed[fileId]
      if (failure === null ? !current : current?.path === failure.path) return state
      const { [fileId]: _gone, ...rest } = state.propertyFailed
      return { propertyFailed: failure ? { ...rest, [fileId]: failure } : rest }
    }),
  recoveryProblems: {},
  setRecoveryProblem: (fileId, problem) =>
    set((state) => {
      if (state.recoveryProblems[fileId] === (problem ?? undefined)) return state
      const { [fileId]: _gone, ...rest } = state.recoveryProblems
      return { recoveryProblems: problem ? { ...rest, [fileId]: problem } : rest }
    }),
  draftOffers: {},
  restored: [],
  merged: [],
  markMerged: (path) =>
    set((state) => (state.merged.includes(path) ? state : { merged: [...state.merged, path] })),
  clearMerged: (path) => set((state) => ({ merged: state.merged.filter((item) => item !== path) })),
  closedSaveFailed: {},
  setClosedSaveFailed: (fileId, failure) =>
    set((state) => {
      if (failure === null) {
        if (!state.closedSaveFailed[fileId]) return state
        const { [fileId]: _gone, ...rest } = state.closedSaveFailed
        return { closedSaveFailed: rest }
      }
      return { closedSaveFailed: { ...state.closedSaveFailed, [fileId]: failure } }
    }),
  setSaveFailed: (fileId, failed) =>
    set((state) => {
      if (Boolean(state.saveFailed[fileId]) === failed) return state
      const { [fileId]: _gone, ...rest } = state.saveFailed
      return { saveFailed: failed ? { ...rest, [fileId]: true } : rest }
    }),
  offerDraft: (fileId, offer) =>
    set((state) => ({ draftOffers: { ...state.draftOffers, [fileId]: offer } })),
  clearDraftOffer: (fileId) =>
    set((state) => {
      if (!state.draftOffers[fileId]) return state
      const { [fileId]: _gone, ...rest } = state.draftOffers
      return { draftOffers: rest }
    }),
  markRestored: (path) =>
    set((state) =>
      state.restored.includes(path) ? state : { restored: [...state.restored, path] },
    ),
  clearRestored: (path) =>
    set((state) => ({ restored: state.restored.filter((item) => item !== path) })),
}))

// Errors of a property change that the card of the note already says (docs/notices.md, section 4): whoever
// catches one (the property dialog) does not say it a second time.
const saidByNoteCard = new WeakSet<object>()

export function markSaidByNoteCard(error: unknown): void {
  if (typeof error === "object" && error !== null) saidByNoteCard.add(error)
}

export function isSaidByNoteCard(error: unknown): boolean {
  return typeof error === "object" && error !== null && saidByNoteCard.has(error)
}

// The journal reports a change of its state; the card of the note shows it until the cause is gone.
subscribeRecoveryProblems(({ id, kind, failed }) => {
  const store = useNoteNoticesStore.getState()
  if (failed) store.setRecoveryProblem(id, kind)
  else if (store.recoveryProblems[id] === kind) store.setRecoveryProblem(id, null)
})

import { create } from "zustand"

/** The two answers to an unsaved draft that was found when a note was opened. */
export interface DraftOffer {
  accept: () => void
  reject: () => void
}

interface NoteNoticesState {
  /** Notes (by document id) whose last save failed; cleared by the next successful save. */
  saveFailed: Record<string, true>
  /** Notes (by document id) whose last change of a property failed. */
  propertyFailed: Record<string, true>
  setPropertyFailed: (fileId: string, failed: boolean) => void
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
  setPropertyFailed: (fileId, failed) =>
    set((state) => {
      if (Boolean(state.propertyFailed[fileId]) === failed) return state
      const { [fileId]: _gone, ...rest } = state.propertyFailed
      return { propertyFailed: failed ? { ...rest, [fileId]: true } : rest }
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

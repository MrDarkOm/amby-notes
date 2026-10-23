import { create } from "zustand"

/** The two answers to an unsaved draft that was found when a note was opened. */
export interface DraftOffer {
  accept: () => void
  reject: () => void
}

interface NoteNoticesState {
  /** Notes (by document id) whose last save failed; cleared by the next successful save. */
  saveFailed: Record<string, true>
  /** Unsaved drafts waiting for an answer, by document id. The note is read only until it comes. */
  draftOffers: Record<string, DraftOffer>
  /** Paths (in the vault) of open notes that came back after a deletion made here. */
  restored: string[]
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
  draftOffers: {},
  restored: [],
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

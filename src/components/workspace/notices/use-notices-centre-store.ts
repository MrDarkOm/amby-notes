import { create } from "zustand"

interface NoticesCentreState {
  /** Ids of the records of "Attention" the person hid. Kept until the restart, not on disk. */
  hidden: string[]
  hide: (id: string) => void
  /** Keeps the hiding of the records that still have a cause. */
  reconcile: (liveIds: string[]) => void
  reset: () => void
}

export const useNoticesCentreStore = create<NoticesCentreState>((set) => ({
  hidden: [],
  hide: (id) =>
    set((state) => (state.hidden.includes(id) ? state : { hidden: [...state.hidden, id] })),
  reconcile: (liveIds) =>
    set((state) => {
      const kept = state.hidden.filter((id) => liveIds.includes(id))
      return kept.length === state.hidden.length ? state : { hidden: kept }
    }),
  reset: () => set({ hidden: [] }),
}))

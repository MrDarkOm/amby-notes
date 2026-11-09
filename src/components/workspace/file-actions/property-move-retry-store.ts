import { create } from "zustand"

// A note that was moved into a database and whose properties were neither carried over nor saved aside
// (docs/notices.md, sections 7 and 8). The properties stay in the note; this keeps the way to ask again,
// so the person can take it from the line under the tree and from the note itself. Memory of this session only:
// the properties are still listed in the note's panel afterwards.

export interface PropertyMoveRetry {
  /** For the sentence: the name of the note. */
  name: string
  /** Reads everything again and asks the question again. */
  retry: () => Promise<void>
}

interface PropertyMoveRetryState {
  /** By note id. */
  failed: Record<string, PropertyMoveRetry>
  set: (noteId: string, entry: PropertyMoveRetry) => void
  clear: (noteId: string) => void
  clearAll: () => void
}

export const usePropertyMoveRetryStore = create<PropertyMoveRetryState>((set) => ({
  failed: {},
  set: (noteId, entry) => set((state) => ({ failed: { ...state.failed, [noteId]: entry } })),
  clear: (noteId) =>
    set((state) => {
      if (!state.failed[noteId]) return state
      const { [noteId]: _gone, ...rest } = state.failed
      return { failed: rest }
    }),
  clearAll: () => set({ failed: {} }),
}))

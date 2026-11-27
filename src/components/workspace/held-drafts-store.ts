import * as React from "react"
import { create } from "zustand"

// A canvas or a sketch whose question about an unsaved version was closed without an answer (docs/notices.md,
// section 9) is "held": the draft stays in the journal, the layer shows what is on the disk and cannot be edited
// (an edit would write over the draft), and the question comes again when the layer is shown again.

export interface HeldDraft {
  /** Asks again; answers by itself: the buffer changes, the draft is dropped or the layer stays held. */
  resolve: () => Promise<void>
  /** True until the body of the document has seen it: the question was only just closed, so it is not asked at once. */
  fresh: boolean
}

interface HeldDraftsState {
  /** By the path of the canvas or sketch file. */
  held: Record<string, HeldDraft>
  hold: (path: string, resolve: () => Promise<void>, fresh?: boolean) => void
  release: (path: string) => void
  acknowledge: (path: string) => void
}

export const useHeldDraftsStore = create<HeldDraftsState>((set) => ({
  held: {},
  hold: (path, resolve, fresh = true) =>
    set((state) => ({ held: { ...state.held, [path]: { resolve, fresh } } })),
  release: (path) =>
    set((state) => {
      if (!state.held[path]) return state
      const { [path]: _gone, ...rest } = state.held
      return { held: rest }
    }),
  acknowledge: (path) =>
    set((state) =>
      state.held[path] && state.held[path].fresh
        ? { held: { ...state.held, [path]: { ...state.held[path], fresh: false } } }
        : state,
    ),
}))

/**
 * What the body of a document wears for a layer file: whether the layer is held (read only), and, when it
 * is shown again, the question again.
 */
export function useHeldDraftGate(path: string, active: boolean): boolean {
  const isHeld = useHeldDraftsStore((state) => Boolean(state.held[path]))
  React.useEffect(() => {
    if (!isHeld) return
    const entry = useHeldDraftsStore.getState().held[path]
    if (!entry) return
    if (entry.fresh) {
      useHeldDraftsStore.getState().acknowledge(path)
      return
    }
    if (active) void entry.resolve()
  }, [isHeld, active, path])
  return isHeld
}

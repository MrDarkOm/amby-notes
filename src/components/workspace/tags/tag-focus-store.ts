import { create } from "zustand"

interface TagFocusState {
  /** A tag someone asked the tags panel to show; the panel takes it and clears it. */
  pending: string | null
  focusTag: (tag: string) => void
  clear: () => void
}

/**
 * Lets a click on a tag elsewhere (the graph, a tag in a note) open the tags panel with that tag
 * searched and unfolded. The panel may mount only after the request, so the request waits here.
 */
export const useTagFocusStore = create<TagFocusState>((set) => ({
  pending: null,
  focusTag: (tag) => set({ pending: tag.replace(/^#/u, "") }),
  clear: () => set({ pending: null }),
}))

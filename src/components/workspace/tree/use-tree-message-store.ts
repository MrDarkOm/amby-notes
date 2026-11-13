import { create } from "zustand"

// The line under the tree (docs/notices.md, sections 3 and 8): the answer to something done in the tree (a move,
// a deletion, a drop of files from the system) is said where the person did it. One line at a time: a new answer
// replaces the old one. The words are keys of the locale, never the text of an error.

export interface TreeMessage {
  id: string
  level: "danger" | "warning" | "info"
  titleKey: string
  params?: Record<string, unknown>
  /** An optional second line: what happened to the data, or what to do. */
  lineKey?: string
  /** An optional button that tries the thing again; the line goes away when it is pressed. */
  action?: { labelKey: string; run: () => void | Promise<void> }
}

interface TreeMessageState {
  message: TreeMessage | null
  show: (message: TreeMessage) => void
  dismiss: () => void
}

export const useTreeMessageStore = create<TreeMessageState>((set) => ({
  message: null,
  show: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}))

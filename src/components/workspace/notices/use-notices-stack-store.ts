import { create } from "zustand"

interface StackState {
  /** The stack of the notification centre is open beside the bell. */
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

/**
 * Whether the stack of cards beside the bell of the dock is open (docs/notices.md, section 5). The toasts read
 * it: while the stack is open they are not shown (the place of the notice is in sight), and the ones that hung
 * go into it.
 */
export const useNoticesStackStore = create<StackState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}))

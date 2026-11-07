import { create } from "zustand"

// The toasts (docs/notices.md, section 6): only the announcement of danger or a decision about an object
// that is not on the screen. The store keeps what is announced; the host draws it and times it.

/** Where the button of a toast leads. A toast never decides anything itself. */
export type ToastTarget = { kind: "centre" } | { kind: "note"; id: string }

export interface ToastInput {
  /** The cause. The same cause again is the same toast, with a number. */
  id: string
  level: "danger" | "decision"
  /** The key of the title in the locale, with its words. */
  titleKey: string
  params?: Record<string, unknown>
  /** The key of the label of the button. */
  actionKey: string
  target: ToastTarget
  /** How many causes it stands for (several conflicts in one pass). */
  count?: number
}

export interface NoticeToast extends ToastInput {
  count: number
  /** Changes whenever the toast is announced again: the host starts its time anew. */
  serial: number
}

interface ToastState {
  toasts: NoticeToast[]
  announce: (input: ToastInput) => void
  dismiss: (id: string) => void
  clear: () => void
}

let serial = 0

export const useNoticeToastStore = create<ToastState>((set) => ({
  toasts: [],
  announce: (input) => {
    // Only danger and a decision are announced; a warning, information or success waits in its own place.
    if (input.level !== "danger" && input.level !== "decision") return
    serial += 1
    set((state) => {
      const same = state.toasts.find((toast) => toast.id === input.id)
      const toast: NoticeToast = {
        ...input,
        count: (same?.count ?? 0) + (input.count ?? 1),
        serial,
      }
      return {
        toasts: same
          ? state.toasts.map((item) => (item === same ? toast : item))
          : [...state.toasts, toast],
      }
    })
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

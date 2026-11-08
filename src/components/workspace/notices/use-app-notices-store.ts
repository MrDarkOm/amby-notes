import { create } from "zustand"

import { useNoticeToastStore } from "./use-notice-toasts-store"

// Notices of the application that have no other place (docs/notices.md, section 3, rule 4): a vault that did not
// open, recovery data that was kept, a link that could not be opened. They live in the notification centre, in the
// section of their level, until the person closes them. Only danger and a decision are announced by a toast
// (section 4); a warning waits quietly, and the number on the bell counts it. The words are keys of the locale:
// never the text of an error, which goes to the log (section 10).

export interface AppNotice {
  /** The cause. The same cause again replaces the notice and, for danger and a decision, is announced again. */
  id: string
  level: "danger" | "decision" | "warning"
  /** The key of the title and its words. */
  titleKey: string
  params?: Record<string, unknown>
  /** The key of the one line under the title: what happened to the data, what to do. */
  lineKey: string
}

interface AppNoticesState {
  notices: AppNotice[]
  post: (notice: AppNotice) => void
  dismiss: (id: string) => void
}

/** The id of the toast that announces a notice. */
function toastId(id: string): string {
  return `app:${id}`
}

export const useAppNoticesStore = create<AppNoticesState>((set) => ({
  notices: [],
  post: (notice) => {
    set((state) => ({
      notices: state.notices.some((item) => item.id === notice.id)
        ? state.notices.map((item) => (item.id === notice.id ? notice : item))
        : [...state.notices, notice],
    }))
    if (notice.level === "warning") return
    useNoticeToastStore.getState().announce({
      id: toastId(notice.id),
      level: notice.level,
      titleKey: notice.titleKey,
      params: notice.params,
      target: { kind: "centre" },
    })
  },
  dismiss: (id) => {
    set((state) => ({ notices: state.notices.filter((item) => item.id !== id) }))
    useNoticeToastStore.getState().dismiss(toastId(id))
  },
}))

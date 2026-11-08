import { create } from "zustand"

// The question of the application (docs/notices.md, section 9): the one way to ask a person before an action that
// is hard to undo. It replaces the windows of the system. The host that draws it is
// [confirm-dialog-host.tsx](../components/confirm-dialog-host.tsx), mounted once in App, so the question works in
// the main window, in the separate window of settings and before any vault is open.

export interface ConfirmOptions {
  /** A question about the action, with the name of the object ("Delete “Plan”?"). */
  title: string
  /** One line about what happens to the data. */
  description?: string
  /** The verb of the action ("Delete"), never "OK". */
  confirmLabel: string
  /** Only where "Cancel" would mislead (it drops something); otherwise the word of the application. */
  cancelLabel?: string
  /** A dangerous action: the button is drawn as dangerous and the focus starts on the safe button. */
  destructive?: boolean
}

export interface PendingConfirm extends ConfirmOptions {
  id: number
}

interface ConfirmState {
  /** The questions waiting for an answer; the first is on the screen. */
  queue: PendingConfirm[]
  /** Answers a question. A second answer to the same question is ignored. */
  settle: (id: number, answer: boolean) => void
}

const resolvers = new Map<number, (answer: boolean) => void>()
let lastId = 0

export const useConfirmStore = create<ConfirmState>((set) => ({
  queue: [],
  settle: (id, answer) => {
    const resolve = resolvers.get(id)
    if (!resolve) return
    resolvers.delete(id)
    set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }))
    resolve(answer)
  },
}))

/**
 * Asks the person and waits. `true` is the action, `false` is "Cancel", Escape or a click beside the
 * window: nothing was done. Questions are shown one at a time, in the order they were asked.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    lastId += 1
    const id = lastId
    resolvers.set(id, resolve)
    useConfirmStore.setState((state) => ({ queue: [...state.queue, { ...options, id }] }))
  })
}

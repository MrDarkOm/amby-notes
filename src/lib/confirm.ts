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
  /** Exact text required before confirming an irreversible server-space deletion (Л10). */
  requiredText?: { value: string; label: string }
  /**
   * A hidden field that must not be empty, such as the current password (appendix Ц, Ц4). The value goes only
   * to `onSubmit`, never into the store; `error` is shown under the field when the question is asked again.
   */
  secret?: { label: string; error?: string; onSubmit?: (value: string) => void }
  /** Dismisses a question whose account or action is no longer current (Л11). */
  signal?: AbortSignal
}

export interface PendingConfirm extends ConfirmOptions {
  id: number
}

/**
 * How a question ended: `yes` (the action button), `no` (the second button) or `dismissed` (Escape or a click
 * beside the window: closed with no answer).
 */
export type ConfirmOutcome = "yes" | "no" | "dismissed"

interface ConfirmState {
  /** The questions waiting for an answer; the first is on the screen. */
  queue: PendingConfirm[]
  /** Answers a question (`true` is yes, `false` is no). A second answer to the same question is ignored. */
  settle: (id: number, answer: boolean | ConfirmOutcome) => void
}

const resolvers = new Map<number, (outcome: ConfirmOutcome) => void>()
let lastId = 0

export const useConfirmStore = create<ConfirmState>((set) => ({
  queue: [],
  settle: (id, answer) => {
    const resolve = resolvers.get(id)
    if (!resolve) return
    resolvers.delete(id)
    set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }))
    resolve(answer === true ? "yes" : answer === false ? "no" : answer)
  },
}))

/**
 * Asks and tells yes, no and closed-without-an-answer apart. For the few questions where "no" does something
 * (the draft of a canvas is deleted) and closing the window must not. Questions are shown one at a time, in the
 * order they were asked.
 */
export function confirmChoice(options: ConfirmOptions): Promise<ConfirmOutcome> {
  return new Promise<ConfirmOutcome>((resolve) => {
    // A question that is no longer current (another account, another action) is never put on the screen.
    if (options.signal?.aborted) {
      resolve("dismissed")
      return
    }
    lastId += 1
    const id = lastId
    resolvers.set(id, resolve)
    options.signal?.addEventListener(
      "abort",
      () => useConfirmStore.getState().settle(id, "dismissed"),
      {
        once: true,
      },
    )
    useConfirmStore.setState((state) => ({ queue: [...state.queue, { ...options, id }] }))
  })
}

/**
 * Asks the person and waits. `true` is the action; `false` is "Cancel", Escape or a click beside the window:
 * nothing was done.
 */
export async function confirm(options: ConfirmOptions): Promise<boolean> {
  return (await confirmChoice(options)) === "yes"
}

/**
 * Asks with a hidden field (`secret`) and gives what was typed in it, or `null` when the action was not chosen.
 * The value is handed over once and is not kept anywhere else.
 */
export async function confirmWithSecret(
  options: ConfirmOptions & { secret: { label: string; error?: string } },
): Promise<string | null> {
  let value: string | null = null
  const chosen = await confirm({
    ...options,
    secret: {
      ...options.secret,
      onSubmit: (typed) => {
        value = typed
      },
    },
  })
  return chosen ? value : null
}

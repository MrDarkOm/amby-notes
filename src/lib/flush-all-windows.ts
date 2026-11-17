import { emit, listen } from "@tauri-apps/api/event"
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window"
import { errorType, logger } from "@/lib/logger"

/**
 * Flushing the pending edits of every window at once (SAVE-04). The window that must not lose text
 * is rarely the one that asks: the update runs in the settings window, the notes live in the main
 * window and in note windows. The asker broadcasts a request; each editing window flushes through
 * the same path as its close handler (`flushBeforeLeaving`) and answers whether its edits are safe
 * (in their file or in a written recovery draft).
 */
const FLUSH_REQUEST_EVENT = "amby:flush-request"
const FLUSH_DONE_EVENT = "amby:flush-done"

/** Windows that never hold edits; the settings window only edits preferences. */
const NON_EDITING_LABELS = new Set(["settings"])
const FLUSH_TIMEOUT_MS = 20_000

interface FlushRequest {
  id: string
}
interface FlushAnswer {
  id: string
  label: string
  safe: boolean
}

let localFlush: (() => Promise<boolean>) | null = null

/**
 * Answer the requests of other windows with this window's flush. Returns the unsubscribe function.
 * `flush` resolves true when every edit of the window is in its file or in a recovery draft.
 */
export async function answerFlushRequests(
  label: string,
  flush: () => Promise<boolean>,
): Promise<() => void> {
  localFlush = flush
  const unlisten = await listen<FlushRequest>(FLUSH_REQUEST_EVENT, async (event) => {
    let safe = false
    try {
      safe = await flush()
    } catch (error) {
      logger.warn("flush_request.failed", { errorType: errorType(error) })
    }
    await emit(FLUSH_DONE_EVENT, { id: event.payload.id, label, safe } satisfies FlushAnswer)
  })
  return () => {
    if (localFlush === flush) localFlush = null
    unlisten()
  }
}

/**
 * Ask every other editing window to flush and wait for all answers. False when a window could not
 * keep its edits, did not answer in time or the request itself failed: the caller must not replace
 * the program then.
 */
export async function flushEditingWindows(): Promise<boolean> {
  const own = getCurrentWindow().label
  const expected = new Set(
    (await getAllWindows())
      .map((window) => window.label)
      .filter((label) => label !== own && !NON_EDITING_LABELS.has(label)),
  )
  const ownFlush = localFlush ? localFlush().catch(() => false) : Promise.resolve(true)
  if (expected.size === 0) return ownFlush

  const id = crypto.randomUUID()
  const cleanup: { unlisten?: () => void; timer?: ReturnType<typeof setTimeout> } = {}
  try {
    const others = new Promise<boolean>((resolve) => {
      cleanup.timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS)
      void listen<FlushAnswer>(FLUSH_DONE_EVENT, (event) => {
        const answer = event.payload
        if (answer.id !== id) return
        if (!answer.safe) return resolve(false)
        expected.delete(answer.label)
        if (expected.size === 0) resolve(true)
      }).then(
        (stop) => {
          cleanup.unlisten = stop
          void emit(FLUSH_REQUEST_EVENT, { id } satisfies FlushRequest).catch(() => resolve(false))
        },
        () => resolve(false),
      )
    })
    const results = await Promise.all([ownFlush, others])
    return results.every(Boolean)
  } finally {
    if (cleanup.timer) clearTimeout(cleanup.timer)
    cleanup.unlisten?.()
  }
}

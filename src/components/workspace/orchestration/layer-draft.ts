import { confirmChoice } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { discardRecoveryDraft, readRecoveryDraft, type RecoveryScope } from "@/lib/recovery-drafts"
import { useHeldDraftsStore } from "../held-drafts-store"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "../recovery-restore"

/** Questions that are on the screen now, by path: a layer asks one at a time. */
const asking = new Set<string>()

export interface LayerDraftOptions {
  path: string
  recoveryScope: RecoveryScope
  /** What is on the disk now, as the layer shows it. */
  disk: string
  /** Checks and normalizes a draft; throws when it is not a valid layer. */
  validate: (json: string) => string
  /** The draft became the content of the layer: keep it as a draft and save it. */
  onRestored: (content: string) => void
  /** Reads the disk again (for the next question). */
  readDisk: () => Promise<string>
  /** Puts the content into the open buffer of the layer. */
  setBuffer: (content: string) => void
}

/**
 * An unsaved version of a canvas or a sketch found when it is opened (docs/notices.md, section 9). "Restore" opens
 * the draft; only the button "Do not restore" drops it. Closing the question without an answer (Escape, a click
 * beside the window) leaves the draft in the journal and holds the layer: it shows the disk, it cannot be
 * edited, and the question is asked again when the layer is opened again.
 */
export async function settleLayerDraft(options: LayerDraftOptions, fresh = true): Promise<string> {
  const { path, recoveryScope, disk, validate } = options
  const recovery = (await readRecoveryDraft(path, recoveryScope))?.content
  let recovered: string | undefined
  if (recovery !== undefined) {
    try {
      recovered = validate(recovery)
    } catch (error) {
      console.error("Ignoring invalid recovery draft:", error)
    }
  }
  const outcome = recoveryNeedsConfirmation(disk, recovered)
    ? await confirmChoice(confirmations.restoreDraft())
    : "no"
  if (outcome === "dismissed") {
    useHeldDraftsStore.getState().hold(path, () => askAgain(options), fresh)
    return disk
  }
  useHeldDraftsStore.getState().release(path)
  const resolved = resolveRecoveryContent(disk, recovered, outcome === "yes")
  if (resolved.discardDraft) void discardRecoveryDraft(path, recoveryScope)
  if (resolved.restored) options.onRestored(resolved.content)
  return resolved.content
}

async function askAgain(options: LayerDraftOptions): Promise<void> {
  if (asking.has(options.path)) return
  asking.add(options.path)
  try {
    const disk = await options.readDisk()
    options.setBuffer(await settleLayerDraft({ ...options, disk }, false))
  } finally {
    asking.delete(options.path)
  }
}

import type { RecoveryDraft } from "@/lib/recovery-drafts"
import { recoveryNeedsConfirmation } from "./recovery-restore"

export interface MarkdownRecoveryLoadOptions {
  fileId: string
  path: string
  diskContent: string
  readDraft: (id: string) => Promise<RecoveryDraft | null>
  isCurrent: () => boolean
}

export type MarkdownRecoveryLoadResult =
  | { status: "stale" }
  | {
      status: "ready"
      /** The text to open: always what is on disk. */
      content: string
      /** An unsaved draft that differs from the disk text; the person is asked in the notices. */
      offer: string | null
      /** A draft that adds nothing and can be dropped. */
      discardDraft: boolean
    }

export class StaleDocumentLoadError extends Error {
  constructor() {
    super("Document load belongs to an inactive vault generation")
    this.name = "StaleDocumentLoadError"
  }
}

/**
 * Resolve a Markdown recovery draft against its authoritative disk content.
 * No journal or document state is mutated here, so a stale vault generation
 * can abandon the decision without discarding recoverable data. A draft that
 * differs is not applied and not asked about here: it comes back as an `offer`
 * that the notices of the note put to the person, while the journal keeps it.
 */
export async function resolveMarkdownRecoveryLoad({
  fileId,
  path,
  diskContent,
  readDraft,
  isCurrent,
}: MarkdownRecoveryLoadOptions): Promise<MarkdownRecoveryLoadResult> {
  const byId = await readDraft(fileId)
  if (!isCurrent()) return { status: "stale" }

  const recovered = byId ?? (path !== fileId ? await readDraft(path) : null)
  if (!isCurrent()) return { status: "stale" }

  if (recovered === null || recovered === undefined) {
    return { status: "ready", content: diskContent, offer: null, discardDraft: false }
  }
  if (recoveryNeedsConfirmation(diskContent, recovered.content)) {
    return { status: "ready", content: diskContent, offer: recovered.content, discardDraft: false }
  }
  return { status: "ready", content: diskContent, offer: null, discardDraft: true }
}

/** Deduplicates concurrent entry points so one note cannot show two recovery prompts. */
export class InFlightDocumentLoads<T> {
  private readonly loads = new Map<string, Promise<T>>()

  run(scope: string, fileId: string, load: () => Promise<T>): Promise<T> {
    const key = `${scope}\u0000${fileId}`
    const existing = this.loads.get(key)
    if (existing) return existing

    const pending = load()
    this.loads.set(key, pending)
    const clear = () => {
      if (this.loads.get(key) === pending) this.loads.delete(key)
    }
    void pending.then(clear, clear)
    return pending
  }
}

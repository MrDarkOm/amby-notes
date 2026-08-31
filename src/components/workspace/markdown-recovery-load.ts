import type { RecoveryDraft } from "@/lib/recovery-drafts"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "./recovery-restore"

export interface MarkdownRecoveryLoadOptions {
  fileId: string
  path: string
  diskContent: string
  readDraft: (id: string) => Promise<RecoveryDraft | null>
  confirmRestore: () => Promise<boolean>
  isCurrent: () => boolean
}

export type MarkdownRecoveryLoadResult =
  | { status: "stale" }
  | {
      status: "ready"
      content: string
      restored: boolean
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
 * can abandon the decision without discarding recoverable data.
 */
export async function resolveMarkdownRecoveryLoad({
  fileId,
  path,
  diskContent,
  readDraft,
  confirmRestore,
  isCurrent,
}: MarkdownRecoveryLoadOptions): Promise<MarkdownRecoveryLoadResult> {
  const byId = await readDraft(fileId)
  if (!isCurrent()) return { status: "stale" }

  const recovered = byId ?? (path !== fileId ? await readDraft(path) : null)
  if (!isCurrent()) return { status: "stale" }

  let restoreConfirmed = false
  if (recoveryNeedsConfirmation(diskContent, recovered?.content)) {
    restoreConfirmed = await confirmRestore()
    if (!isCurrent()) return { status: "stale" }
  }

  return {
    status: "ready",
    ...resolveRecoveryContent(diskContent, recovered?.content, restoreConfirmed),
  }
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

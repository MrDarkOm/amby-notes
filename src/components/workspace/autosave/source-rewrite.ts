// A note opened in Live Preview may hold text the editor would spell differently
// (`* * *`, `1)`, a sparse list). Such a block keeps its source until it is edited; the
// save that first writes it in the editor's own form replaces the last file holding the
// author's spelling. The editor announces that save here, and the write that follows asks
// the backend for a history snapshot that is never coalesced with autosaves.
//
// The request stays pending until a write that started after it has succeeded: a save
// already in flight carries older content and must not consume it, and a failed save
// leaves it for the retry.

const pending = new Map<string, number>()
let sequence = 0

/** The next save of this document must keep the file it replaces in history. */
export function requestSourceRewriteSnapshot(documentId: string): void {
  pending.set(documentId, ++sequence)
}

/** The pending request a write should carry, or `null`. Call when the write starts. */
export function pendingSourceRewriteSnapshot(documentId: string): number | null {
  return pending.get(documentId) ?? null
}

/** Call after the write succeeded; a newer request made meanwhile stays pending. */
export function settleSourceRewriteSnapshot(documentId: string, request: number | null): void {
  if (request !== null && pending.get(documentId) === request) pending.delete(documentId)
}

/** Drops everything, for tests and vault switches. */
export function clearSourceRewriteSnapshots(): void {
  pending.clear()
}

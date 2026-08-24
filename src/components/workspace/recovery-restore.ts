/**
 * Resolve a recovery draft only after its caller has compared it with the
 * authoritative on-disk content. The caller owns prompting and journal I/O;
 * this pure result keeps refusal from ever mutating the disk buffer.
 */
export function resolveRecoveryContent(
  diskContent: string,
  recoveredContent: string | undefined,
  restoreConfirmed: boolean,
): { content: string; restored: boolean; discardDraft: boolean } {
  if (recoveredContent === undefined || recoveredContent === diskContent) {
    return { content: diskContent, restored: false, discardDraft: recoveredContent !== undefined }
  }
  if (restoreConfirmed) {
    return { content: recoveredContent, restored: true, discardDraft: false }
  }
  return { content: diskContent, restored: false, discardDraft: true }
}

export function recoveryNeedsConfirmation(
  diskContent: string,
  recoveredContent: string | undefined,
): boolean {
  return recoveredContent !== undefined && recoveredContent !== diskContent
}

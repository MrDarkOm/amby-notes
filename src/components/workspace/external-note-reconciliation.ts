/**
 * A dirty editor may already contain the next edit while the disk still holds
 * its last saved revision. Delayed reads may also return the baseline captured
 * before a local save completed. Neither result is an external change.
 */
export function isUnchangedNoteRevision(
  diskRevision: string,
  currentRevision: string | undefined,
  revisionBeforeRead: string | undefined,
): boolean {
  return diskRevision === currentRevision || diskRevision === revisionBeforeRead
}

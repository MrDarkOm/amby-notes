import type { FsMutationResult, UndoRecord } from "./types"

/**
 * «Вернуть» for operations that changed other notes (docs/notices.md, section 9): a rename or a move
 * that rewrote links, and a merge. Rust `commands/undo.rs` does it exactly by the record the result
 * carried, and refuses with `undoItemMoved`, `undoNoteChanged` or `undoUnavailable` when anything
 * changed since; the browser adapter keeps no versions and offers nothing to undo.
 */
export interface UndoPort {
  undoMutation(record: UndoRecord): Promise<FsMutationResult>
  /** Keeps the target's text before a merge; `null` where a merge cannot be undone (the browser). */
  beginMerge(targetPath: string): Promise<string | null>
  /** After the merged text is saved: the merged note goes to the archive; the result can undo it. */
  finishMerge(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
    snapshotId: string,
  ): Promise<FsMutationResult>
}

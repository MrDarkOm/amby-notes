import { FileRevisionConflictError, confirmAction, getFileRevision, writeFile } from "@/lib/storage"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"

/** Thrown after the user was told about a conflict; the autosave is paused. */
export class FileConflictPausedError extends Error {
  constructor() {
    super("File changed on disk; autosave paused")
    this.name = "FileConflictPausedError"
  }
}

/**
 * Compare-and-swap baselines for non-note files (Canvas, Excalidraw). A buffer
 * may only overwrite the revision it was loaded from, so an external edit that
 * arrives between load and autosave is reported instead of silently replaced.
 * Callers read the baseline BEFORE reading the file: if the file changes in
 * between, the buffer is newer than its baseline and the next save conflicts,
 * which is the safe direction.
 */
export class FileRevisionTracker {
  private readonly revisions = new Map<string, string>()

  /** Read the current revision without adopting it; call before reading the file. */
  capture(path: string): Promise<string> {
    return getFileRevision(path)
  }

  /** Adopt a captured revision once the content read after it was accepted. */
  commit(path: string, revision: string): void {
    this.revisions.set(path, revision)
  }

  /** Capture and adopt in one step (initial load). */
  async baseline(path: string): Promise<void> {
    this.commit(path, await this.capture(path))
  }

  forget(path: string): void {
    this.revisions.delete(path)
  }

  /**
   * Conditional save. On an external edit the file is left untouched and the
   * user chooses: overwrite with this buffer (the baseline moves to the current
   * disk revision and the save is retried once) or keep the external version,
   * which pauses the autosave queue via `onConflict` while the local buffer
   * stays in its recovery draft.
   */
  async save(
    path: string,
    content: string,
    operationId: string | undefined,
    onConflict: () => void,
  ): Promise<void> {
    let expected = this.revisions.get(path)
    if (expected === undefined) {
      // Remapped (renamed) paths have no baseline yet; fall back to the
      // current revision rather than blocking the save, and leave a trace.
      logger.warn("file_revision.save_without_baseline", {})
      expected = await getFileRevision(path)
    }
    try {
      this.revisions.set(path, await writeFile(path, content, operationId, expected))
      return
    } catch (error) {
      if (!(error instanceof FileRevisionConflictError)) throw error
    }
    const overwrite = await confirmAction(i18n.t("errors.fileChangedExternally")).catch(() => false)
    if (!overwrite) {
      onConflict()
      throw new FileConflictPausedError()
    }
    try {
      const current = await getFileRevision(path)
      this.revisions.set(path, await writeFile(path, content, operationId, current))
    } catch (error) {
      if (!(error instanceof FileRevisionConflictError)) throw error
      // Changed again while asking: stop and let the user decide again later.
      onConflict()
      throw new FileConflictPausedError()
    }
  }
}

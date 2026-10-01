import {
  FileRevisionConflictError,
  getFileRevision,
  writeFile,
  showErrorMessage,
} from "@/lib/storage"
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

  /** Capture the baseline; call immediately before reading the file. */
  async baseline(path: string): Promise<void> {
    this.revisions.set(path, await getFileRevision(path))
  }

  forget(path: string): void {
    this.revisions.delete(path)
  }

  /**
   * Conditional save. A conflict leaves the file untouched, keeps the local
   * buffer (and its recovery draft) and rethrows as FileConflictPausedError
   * after `onConflict` pauses the autosave queue.
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
      const next = await writeFile(path, content, operationId, expected)
      this.revisions.set(path, next)
    } catch (error) {
      if (!(error instanceof FileRevisionConflictError)) throw error
      onConflict()
      void showErrorMessage(i18n.t("errors.fileChangedExternally")).catch(() => undefined)
      throw new FileConflictPausedError()
    }
  }
}

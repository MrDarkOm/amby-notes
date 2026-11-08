// One place that turns a failed operation into the text a person reads and the code a log keeps
// (docs/notices.md §10, §13). Only the code of an error is trusted: what Rust, the OS or a library
// wrote in `message` is for the logs and is never shown. The sync errors have their own dictionary
// (sync/sync-errors.ts).

import type { TFunction } from "i18next"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import {
  DatabaseOperationError,
  FileRevisionConflictError,
  NoteRevisionConflictError,
  ProjectOperationError,
  StorageOperationError,
} from "@/lib/storage"
import {
  databaseErrorCode,
  databaseFailureText,
  writeWarningNotices,
  KNOWN_DATABASE_FAILURE_REASONS,
  type SchemaChange,
} from "./database-errors"
import { projectErrorCode, projectFailureText } from "./project-errors"

export { KNOWN_DATABASE_FAILURE_REASONS }

/**
 * A failure whose message is already the text for the person (taken from the dictionary where it
 * was found), carried through code that shows it later. Never build it from a backend sentence.
 */
export class ShownError extends Error {
  constructor(text: string) {
    super(text)
    this.name = "ShownError"
  }
}

export interface OperationErrorOptions {
  /** What was being changed; only a refusal because values exist is worded by it. */
  change?: SchemaChange
}

/** The stable code of an error: the reason, the kind or the storage code; `unknown` for the rest. */
export function operationErrorCode(error: unknown): string {
  if (error instanceof ShownError) return "shown"
  if (error instanceof DatabaseOperationError) return databaseErrorCode(error)
  if (error instanceof ProjectOperationError) return projectErrorCode(error)
  if (error instanceof NoteRevisionConflictError || error instanceof FileRevisionConflictError) {
    return "revision_conflict"
  }
  if (error instanceof StorageOperationError) return error.code
  return "unknown"
}

/** The text of a failed operation, from the dictionary; never what the failure said itself. */
export function operationErrorText(
  error: unknown,
  t: TFunction = i18n.t.bind(i18n),
  options: OperationErrorOptions = {},
): string {
  if (error instanceof ShownError) return error.message
  if (error instanceof DatabaseOperationError) {
    return databaseFailureText(error, t, options.change)
  }
  if (error instanceof ProjectOperationError) return projectFailureText(t, error)
  if (error instanceof NoteRevisionConflictError || error instanceof FileRevisionConflictError) {
    return t("operationErrors.revision_conflict")
  }
  if (error instanceof StorageOperationError && error.code !== "operationFailed") {
    return t(`operationErrors.${error.code}`)
  }
  return t("operationErrors.general", { code: operationErrorCode(error) })
}

/**
 * The text for a failed operation, and a line in the debug log with its code (docs/notices.md §13).
 * For a place that shows the failure and has no log line of its own.
 */
export function reportOperationError(error: unknown, options: OperationErrorOptions = {}): string {
  logger.warn("operation.failed", { failureCode: operationErrorCode(error), error })
  return operationErrorText(error, undefined, options)
}

/** The thing the action was about is gone (renamed, deleted, moved) — by reason or by storage code. */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) return error.reason === "not_found"
  if (error instanceof ProjectOperationError) {
    return ["workshopNotFound", "storyNotFound", "sectionNotFound", "pageNotFound"].includes(
      error.kind,
    )
  }
  return error instanceof StorageOperationError && error.code === "notFound"
}

/** Another window or computer changed the file first, by reason or by the revision errors. */
export function isRevisionConflict(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) return error.reason === "revision_conflict"
  if (error instanceof ProjectOperationError) return error.kind === "revisionConflict"
  return error instanceof NoteRevisionConflictError || error instanceof FileRevisionConflictError
}

/** The text of any failure of a workshop operation (`t` first, as the workshop code calls it). */
export function projectErrorText(t: TFunction, error: unknown): string {
  return operationErrorText(error, t)
}

/**
 * The notices for the warnings that came back with a successful write: one dictionary text, and a
 * line in the debug log with how many there were.
 */
export function warningNotices(warnings: readonly string[]): string[] {
  if (warnings.length > 0) logger.warn("database.write_warnings", { count: warnings.length })
  return writeWarningNotices(warnings, i18n.t.bind(i18n))
}

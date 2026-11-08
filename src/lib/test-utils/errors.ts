import type { FailureReason } from "@/lib/bindings"
import { DatabaseOperationError, ProjectOperationError } from "@/lib/storage"

/** A refusal as the desktop adapter raises it: the English sentence is only the developer's. */
export function databaseFailure(
  reason: FailureReason,
  raw = "Raw Rust sentence for /Users/someone/Vault/Notes/A.md",
  code = "databaseRenameFailed",
): DatabaseOperationError {
  return new DatabaseOperationError("failed", raw, code, reason)
}

/** An unclassified project failure as the desktop adapter raises it (`code` is the Rust one). */
export function projectFailure(
  code = "projectIndexFailed",
  raw = "Raw Rust sentence for /Users/someone/Vault/Notes/A.md",
): ProjectOperationError {
  return new ProjectOperationError("failed", raw, { kind: "failed", code, message: raw })
}

/** A project file that changed after it was read. */
export function projectRevisionConflict(): ProjectOperationError {
  return new ProjectOperationError("revisionConflict", "Revision conflict", {
    kind: "revisionConflict",
    actualRevision: "r2",
  })
}

import type { FailureReason } from "@/lib/bindings"
import { DatabaseOperationError } from "@/lib/storage"

/** A refusal as the desktop adapter raises it: the English sentence is only the developer's. */
export function databaseFailure(
  reason: FailureReason,
  raw = "Raw Rust sentence for /Users/someone/Vault/Notes/A.md",
  code = "databaseRenameFailed",
): DatabaseOperationError {
  return new DatabaseOperationError("failed", raw, code, reason)
}

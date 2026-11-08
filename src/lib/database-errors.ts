// Machine reasons of the database commands → texts of the interface (docs/notices.md §10).
// The backend's own sentence is never shown: only the reason is trusted
// (src-tauri/src/database/failure.rs). An unknown reason, or `failed`, has the general text.

import type { TFunction } from "i18next"
import type { FailureReason } from "@/lib/bindings"
import { DatabaseOperationError } from "@/lib/storage"

/** What was being changed, which decides how a refusal for existing values is worded. */
export type SchemaChange = "type" | "relation" | "date"

/** Every reason the interface knows a text for; `failed` is the general one. */
const REASONS: Record<FailureReason, true> = {
  revision_conflict: true,
  locked: true,
  read_only: true,
  not_found: true,
  name_taken: true,
  invalid_name: true,
  values_not_empty: true,
  has_dependents: true,
  formula_invalid: true,
  last_view: true,
  invalid_config: true,
  relation_invalid: true,
  invalid_value: true,
  too_large: true,
  rolled_back: true,
  recovery_required: true,
  stale_cursor: true,
  yaml_conflict: true,
  io: true,
  failed: true,
}

export const KNOWN_DATABASE_FAILURE_REASONS = Object.keys(REASONS) as FailureReason[]

const GENERAL_KEY = "databaseErrors.general"

function isKnownReason(reason: string | undefined): reason is FailureReason {
  return reason !== undefined && Object.prototype.hasOwnProperty.call(REASONS, reason)
}

/** The stable code of a database failure: the reason, or the command's own code when unclassified. */
export function databaseErrorCode(error: DatabaseOperationError): string {
  if (error.kind !== "failed") return error.kind
  if (isKnownReason(error.reason) && error.reason !== "failed") return error.reason
  return error.code ?? "unknown"
}

/** The text of a failed database operation. */
export function databaseFailureText(
  error: DatabaseOperationError,
  t: TFunction,
  change: SchemaChange = "type",
): string {
  switch (error.kind) {
    case "moduleDisabled":
      return t("databaseErrors.moduleDisabled")
    case "vaultNotOpen":
      return t("databaseErrors.vaultNotOpen")
    case "vaultGenerationConflict":
      return t("databaseErrors.vaultChanged")
    case "failed":
      break
  }
  if (!isKnownReason(error.reason) || error.reason === "failed") {
    return t(GENERAL_KEY, { code: databaseErrorCode(error) })
  }
  if (error.reason === "values_not_empty") {
    return t(
      change === "relation"
        ? "databaseErrors.relationValues"
        : change === "date"
          ? "databaseErrors.dateValues"
          : "databaseErrors.typeValues",
    )
  }
  return t(`databaseErrors.reason.${error.reason}`)
}

/**
 * What the backend reports beside a write that went through (`warnings`: an index that could not be
 * refreshed at once, a related value it could not update). The sentences are the developer's and go
 * to the log; the person gets one text, because the write itself succeeded.
 */
export function writeWarningNotices(warnings: readonly string[], t: TFunction): string[] {
  if (warnings.length === 0) return []
  return [t("databaseErrors.writtenWithWarnings")]
}

const DIAGNOSTIC_CODES = new Set([
  "brokenManifest",
  "unsupportedManifest",
  "invalidManifest",
  "duplicateDatabaseId",
  "duplicateDatabaseTitle",
  "brokenNote",
  "invalidNoteId",
  "duplicateNoteId",
  "duplicateNoteTitle",
  "brokenShard",
  "orphanShard",
  "missingShard",
  "databaseIdMismatch",
  "invalidShardFilename",
  "symlinkEscape",
  "nestedBoundary",
])

/**
 * The text for a remark the backend makes about a database (`DatabaseDiagnostic`): by its code, never its own
 * sentence. A code without a text gets the general one with the code.
 */
export function databaseDiagnosticText(code: string, t: TFunction): string {
  // The backend writes the code with a capital first letter (`BrokenManifest`).
  const key = code.charAt(0).toLowerCase() + code.slice(1)
  if (DIAGNOSTIC_CODES.has(key)) return t(`databaseErrors.diagnostic.${key}`)
  return t("databaseErrors.diagnostic.general", { code })
}

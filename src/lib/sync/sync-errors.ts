// Machine codes of the sync commands → texts of the interface (docs/sync-plan.md, Б.0.1).
// The server's own text is never shown: only the code is trusted (П4).

import type { TFunction } from "i18next"
import { SyncPortError } from "./sync-port"

/** Every code the interface knows a text for: table Б.0.1, the client, the application. */
export const KNOWN_SYNC_ERROR_CODES: readonly string[] = [
  // table Б.0.1: what the connect screen can meet
  "bad_request",
  "unauthorized",
  "token_revoked",
  "invalid_credentials",
  "invalid_enroll_code",
  "enroll_code_expired",
  "invalid_proof",
  "not_found",
  "keys_conflict",
  "payload_too_large",
  "rate_limited",
  "internal",
  "not_implemented",
  // the client (sync/client)
  "invalid_url",
  "insecure_url",
  "invalid_username",
  "invalid_device_name",
  "network",
  "timeout",
  "bad_response",
  "server_unavailable",
  "unsupported_server",
  "cannot_decrypt",
  "crypto",
  // the application
  "weak_password",
  "password_too_short",
  "no_pending_account",
  "recovery_confirmation_mismatch",
  "invalid_recovery_code",
  "not_connected",
  "already_connected",
  "keychain_unavailable",
  "storage_error",
  "unavailable",
  "ipc_failed",
  // the data protocol (Б.0.1) and the sync of a vault (stage Э4)
  "quota_exceeded",
  "blob_too_large",
  "space_exists",
  "test_vault_required",
  "space_not_found",
  "invalid_space",
  "no_vault_open",
  "sync_not_running",
  "conflict_not_found",
  "conflict_changed",
  "vault_locked",
  "state_error",
  "state_newer",
]

const UNKNOWN_KEY = "sync.errors.unknown"

/** The translation key of an error code; an unknown code has the general key. */
export function syncErrorKey(code: string): string {
  return KNOWN_SYNC_ERROR_CODES.includes(code) ? `sync.errors.${code}` : UNKNOWN_KEY
}

/** The text of a machine code (a status of the sync of a vault carries one). */
export function syncCodeMessage(code: string, t: TFunction): string {
  return t(syncErrorKey(code), { code })
}

/** "14 мин", "45 с": the wait of a rate limit in words, rounded up to the largest unit. */
export function formatWait(seconds: number, t: TFunction): string {
  const whole = Math.max(1, Math.ceil(seconds))
  if (whole < 60) return t("sync.wait.seconds", { n: whole })
  if (whole < 3600) return t("sync.wait.minutes", { n: Math.ceil(whole / 60) })
  return t("sync.wait.hours", { n: Math.ceil(whole / 3600) })
}

/** The text for a thrown value: a `SyncPortError` is translated, anything else is the general text. */
export function syncErrorMessage(error: unknown, t: TFunction): string {
  if (!(error instanceof SyncPortError)) return t(UNKNOWN_KEY, { code: "unknown" })
  if (error.code === "rate_limited") {
    return error.retryAfterSecs === null
      ? t("sync.errors.rate_limited_nowait")
      : t("sync.errors.rate_limited", { wait: formatWait(error.retryAfterSecs, t) })
  }
  return t(syncErrorKey(error.code), { code: error.code })
}

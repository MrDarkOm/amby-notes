// Machine codes of the sync commands → texts of the interface (docs/sync-plan.md, Б.0.1).
// The server's own text is never shown: only the code is trusted (П4).

import type { TFunction } from "i18next"
import { SyncPortError } from "./sync-port"

/** Every code the interface knows a text for. */
export const KNOWN_SYNC_ERROR_CODES: readonly string[] = []

/** The translation key of an error code; an unknown code has the general key. */
export function syncErrorKey(code: string): string {
  void code
  throw new Error("not implemented")
}

/** "14 мин", "45 с": the wait of a rate limit in words. */
export function formatWait(seconds: number, t: TFunction): string {
  void seconds
  void t
  throw new Error("not implemented")
}

/** The text for a thrown value: a `SyncPortError` is translated, anything else is the general text. */
export function syncErrorMessage(error: unknown, t: TFunction): string {
  void error
  void t
  void SyncPortError
  throw new Error("not implemented")
}

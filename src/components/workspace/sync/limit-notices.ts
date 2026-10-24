import type { VaultSyncStatus } from "@/lib/sync/sync-port"

/** A notice about a limit of the plan (appendix Е, У3). One per cause. */
export type LimitNotice =
  { kind: "tooLarge"; count: number; maxBytes: number } | { kind: "quotaFull" }

/**
 * The notices the status of the sync asks for: "files over the limit were not sent" (the count
 * and the limit of the files listed as `tooLarge`) and "the storage is full" (any `quotaFull`).
 * Nothing for a server without limits.
 *
 * STUB of the red-tests step: no notices.
 */
export function limitNoticesOf(status: VaultSyncStatus): LimitNotice[] {
  void status
  return []
}

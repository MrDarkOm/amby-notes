import type { VaultSyncStatus } from "@/lib/sync/sync-port"

/** A notice about a limit of the plan (appendix Е, У3). One per cause. */
export type LimitNotice =
  { kind: "tooLarge"; count: number; maxBytes: number } | { kind: "quotaFull" }

/**
 * The notices the status of the sync asks for: "files over the limit were not sent" (the count
 * and the limit of the files listed as `tooLarge`) and "the storage is full" (any `quotaFull`).
 * Nothing for a server without limits.
 */
export function limitNoticesOf(status: VaultSyncStatus): LimitNotice[] {
  const notices: LimitNotice[] = []
  const large = status.unsynced.filter((item) => item.reason === "tooLarge")
  if (large.length > 0) {
    const limits = large
      .map((item) => item.maxBytes)
      .filter((n): n is number => typeof n === "number")
    notices.push({
      kind: "tooLarge",
      count: large.length,
      maxBytes: limits.length > 0 ? Math.min(...limits) : 0,
    })
  }
  if (status.unsynced.some((item) => item.reason === "quotaFull"))
    notices.push({ kind: "quotaFull" })
  return notices
}

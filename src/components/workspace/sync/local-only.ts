import type { VaultSyncStatus } from "@/lib/sync/sync-port"

type Unsynced = VaultSyncStatus["unsynced"][number]

/**
 * Reasons that are a rule of sync, not a fault: the file stays on this computer by design and nothing
 * waits for the person. Such files are information; they never put the sync in a "needs attention" state.
 */
const LOCAL_ONLY_REASONS: readonly string[] = ["tooBigForMemory", "symlink", "excludedPath"]

export const isLocalOnly = (item: Unsynced): boolean => LOCAL_ONLY_REASONS.includes(item.reason)

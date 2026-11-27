import { listSnapshots } from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"

/** The reason sync gives the snapshot it takes before it writes over a note (`history::SYNC_OVERWRITE_REASON`). */
const SYNC_OVERWRITE = "sync-overwrite"

/** A snapshot taken longer ago than this is not the one of the event just recorded. */
const RECENT_MS = 5 * 60 * 1000

/**
 * The snapshot sync took before it changed `target` (a merge, a version chosen in a comparison), so the
 * journal can offer "Вернуть" (docs/notices.md, section 10). `undefined` when there is none: the entry
 * then has no button.
 */
export async function findSyncSnapshot(
  vault: string,
  target: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  try {
    const path = `${vault.replace(/[\\/]+$/u, "")}/${target}`
    const snapshots = await listSnapshots(path)
    const recent = snapshots
      .filter((item) => item.reason === SYNC_OVERWRITE && now - item.createdAtMs <= RECENT_MS)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    return recent[0]?.id
  } catch (error) {
    // Without the history the entry is still said; it only has no "Вернуть" button.
    logger.warn("notices.snapshot_lookup_failed", { errorType: errorType(error) })
    return undefined
  }
}

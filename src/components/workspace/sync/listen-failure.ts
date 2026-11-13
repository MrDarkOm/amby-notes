import { errorType, logger } from "@/lib/logger"
import { useAppNoticesStore } from "../notices/use-app-notices-store"

// A sync status that could not be subscribed to stops updating the screen that wanted it
// (docs/notices.md, sections 12 and 13). The data are untouched, so it is a `warning` in the centre,
// once however many screens failed; the screen that shows a state says it does not know it.

const NOTICE_ID = "sync-listen-failed"

export function reportSyncListenFailed(error: unknown): void {
  logger.warn("sync.listen_failed", { errorType: errorType(error) })
  useAppNoticesStore.getState().post({
    id: NOTICE_ID,
    level: "warning",
    titleKey: "notices.app.syncListenFailed.title",
    lineKey: "notices.app.syncListenFailed.line",
  })
}

/** The subscription works again: the warning has nothing left to say. */
export function clearSyncListenFailed(): void {
  useAppNoticesStore.getState().dismiss(NOTICE_ID)
}

import type { NoticeLevel } from "../notices/notice-look"
import { useSyncNoticesStore } from "./use-sync-notices-store"

/**
 * What the notices button of the dock says: how many causes are behind it and how serious the worst is
 * (a conflict is a decision, a limit of the plan a warning; docs/notices.md, section 2.1). `null` while
 * there is nothing to say: the button stays, the number goes.
 */
export function useNoticesDockSummary(): { count: number; level: NoticeLevel } | null {
  const conflicts = useSyncNoticesStore((state) => state.conflicts.length)
  const limits = useSyncNoticesStore((state) => state.limits.length)
  const count = conflicts + limits
  if (count === 0) return null
  return { count, level: conflicts > 0 ? "decision" : "warning" }
}

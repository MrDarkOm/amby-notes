import { centreCounter } from "../notices/centre-entries"
import type { NoticeLevel } from "../notices/notice-look"
import { useNoticesCentre } from "../notices/use-notices-centre"

/**
 * What the notices button of the dock says: how many records "Needs a decision" and "Attention" hold and
 * how serious the worst is (docs/notices.md, section 5). The journal never counts. `null` while there is
 * nothing to say: the button stays, the number goes.
 */
export function useNoticesDockSummary(): { count: number; level: NoticeLevel } | null {
  return centreCounter(useNoticesCentre())
}

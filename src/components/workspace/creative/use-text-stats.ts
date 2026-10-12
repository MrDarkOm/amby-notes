import * as React from "react"
import { listTextStats, type TextPageStat } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"

const NONE: Record<string, TextPageStat> = {}

/**
 * Words and last-change time of the pages of one text database, by note ID. They come from the
 * note index in one read-only call, so a list can show them without opening a single file. They
 * are decoration: while the call is out, or when it fails, a page simply has no numbers.
 */
export function useTextStats(
  databaseId: string | null | undefined,
  refreshKey = 0,
): Record<string, TextPageStat> {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [stats, setStats] = React.useState<Record<string, TextPageStat>>(NONE)

  React.useEffect(() => {
    if (!databaseId || vaultGeneration === null) {
      setStats(NONE)
      return undefined
    }
    let cancelled = false
    listTextStats(databaseId)
      .then((list) => {
        if (!cancelled) setStats(Object.fromEntries(list.map((entry) => [entry.noteId, entry])))
      })
      .catch(() => {
        if (!cancelled) setStats(NONE)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, vaultGeneration, invalidationSeq, refreshKey])

  return stats
}

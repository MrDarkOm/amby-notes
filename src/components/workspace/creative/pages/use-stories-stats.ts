import * as React from "react"
import {
  listTextStats,
  type DatabaseRow,
  type StorySummary,
  type TextPageStat,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { computeStoryStat, type StoryStat } from "./story-stats-model"

const NONE: Record<string, TextPageStat[]> = {}

export interface StoriesStats {
  /** By story ID; a story whose text could not be read has none. */
  stats: Record<string, StoryStat>
  /** The rows of every story's text, by database ID: the page titles and statuses. */
  textRows: Readonly<Record<string, DatabaseRow[]>>
  loading: boolean
}

/**
 * Words, pages, done pages and last change of every story, one read-only `listTextStats` per
 * story text (in parallel, as `useTextStats` does for one) plus the rows of those texts for the
 * titles and the status. All of it is decoration: a failed read leaves a story with no numbers.
 */
export function useStoriesStats(stories: readonly StorySummary[], refreshKey = 0): StoriesStats {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [pageStats, setPageStats] = React.useState<Record<string, TextPageStat[]>>(NONE)
  const [statsReady, setStatsReady] = React.useState(false)

  const databaseIds = React.useMemo(
    () => stories.flatMap((story) => (story.databaseId ? [story.databaseId] : [])),
    [stories],
  )
  const idsKey = [...new Set(databaseIds)].sort().join("|")

  React.useEffect(() => {
    const ids = idsKey ? idsKey.split("|") : []
    if (ids.length === 0 || vaultGeneration === null) {
      setPageStats(NONE)
      setStatsReady(true)
      return undefined
    }
    let cancelled = false
    setStatsReady(false)
    void Promise.all(
      ids.map((databaseId) =>
        listTextStats(databaseId).then(
          (list) => [databaseId, list] as const,
          () => [databaseId, [] as TextPageStat[]] as const,
        ),
      ),
    ).then((entries) => {
      if (cancelled) return
      setPageStats(Object.fromEntries(entries))
      setStatsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [idsKey, vaultGeneration, invalidationSeq, refreshKey])

  const data = useDatabaseRows(databaseIds, refreshKey)

  const stats = React.useMemo(() => {
    const result: Record<string, StoryStat> = {}
    for (const story of stories) {
      if (!story.databaseId) continue
      result[story.storyId] = computeStoryStat(
        story,
        pageStats[story.databaseId] ?? [],
        data.rows[story.databaseId],
      )
    }
    return result
  }, [data.rows, pageStats, stories])

  return {
    stats,
    textRows: data.rows,
    loading:
      databaseIds.length > 0 &&
      (!statsReady || data.status === "loading" || data.status === "idle"),
  }
}

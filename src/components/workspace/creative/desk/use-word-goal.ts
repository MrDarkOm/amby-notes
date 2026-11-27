import * as React from "react"
import {
  readWorkshopPrefs,
  subscribeWorkshopPrefs,
  workshopPrefsSnapshot,
  writeWorkshopPrefs,
} from "../creative-scope-storage"
import { recordWords, streakOf, writtenOn, type WordLog } from "./word-goal-model"

/** Today in the author's own time zone, as the log keys days. */
function localDay(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * The daily word goal of a story on this device: the goal, today's words and the streak. The
 * story's word count is recorded once it is known (`counted`), so the first visit of a day sets
 * where the day began. Kept in the workshop's preferences, never in the vault.
 */
export function useWordGoal(
  vaultPath: string | null,
  storyId: string | null,
  totalWords: number,
  counted: boolean,
) {
  const snapshot = React.useSyncExternalStore(subscribeWorkshopPrefs, workshopPrefsSnapshot)
  const entry =
    vaultPath && storyId ? readWorkshopPrefs(vaultPath, snapshot).wordGoals?.[storyId] : undefined
  const today = localDay()

  React.useEffect(() => {
    if (!vaultPath || !storyId || !counted) return
    const goals = readWorkshopPrefs(vaultPath).wordGoals ?? {}
    const current = goals[storyId] ?? {}
    const log: WordLog = current.log ?? {}
    const next = recordWords(log, today, totalWords)
    if (next === log) return
    writeWorkshopPrefs(vaultPath, { wordGoals: { ...goals, [storyId]: { ...current, log: next } } })
  }, [counted, storyId, today, totalWords, vaultPath])

  const setGoal = (goal: number | null) => {
    if (!vaultPath || !storyId) return
    const goals = readWorkshopPrefs(vaultPath).wordGoals ?? {}
    const current = { ...goals[storyId] }
    if (goal === null) delete current.goal
    else current.goal = goal
    writeWorkshopPrefs(vaultPath, { wordGoals: { ...goals, [storyId]: current } })
  }

  const log: WordLog = entry?.log ?? {}
  const goal = entry?.goal ?? null
  return {
    goal,
    written: writtenOn(log, today),
    streak: goal ? streakOf(log, goal, today) : 0,
    setGoal: vaultPath && storyId ? setGoal : null,
  }
}

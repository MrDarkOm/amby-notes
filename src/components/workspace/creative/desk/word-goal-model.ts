/**
 * The daily word goal of a story (pure). The words of the text are counted by the note index;
 * the desk records the count it sees each day, so what was written on a day is the last count of
 * that day minus the count it began with (the last count of the day before it, or the first
 * count seen that day). Only this device keeps the log, in the workshop's preferences.
 */

/** Words of a story by day (`YYYY-MM-DD`): the count when the day began and the last one seen. */
export type WordLog = Record<string, { start: number; last: number }>

const KEEP_DAYS = 60

/** The log with today's count recorded; the same object when nothing changes. */
export function recordWords(log: WordLog, day: string, total: number): WordLog {
  const today = log[day]
  if (today) {
    if (today.last === total) return log
    return { ...log, [day]: { start: today.start, last: total } }
  }
  const earlier = Object.keys(log)
    .filter((date) => date < day)
    .sort()
  const before = earlier[earlier.length - 1]
  const start = before ? log[before].last : total
  const next: WordLog = { ...log, [day]: { start, last: total } }
  const days = Object.keys(next).sort()
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete next[old]
  return next
}

/** The words added on a day; deleting more than was written is not a negative day. */
export function writtenOn(log: WordLog, day: string): number {
  const entry = log[day]
  return entry ? Math.max(0, entry.last - entry.start) : 0
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * The days in a row that reached the goal, ending today, or yesterday while today is not
 * reached yet (a streak is not lost before the day is over).
 */
export function streakOf(log: WordLog, goal: number, today: string): number {
  if (!(goal > 0)) return 0
  let day = writtenOn(log, today) >= goal ? today : previousDay(today)
  let streak = 0
  while (writtenOn(log, day) >= goal) {
    streak += 1
    day = previousDay(day)
  }
  return streak
}

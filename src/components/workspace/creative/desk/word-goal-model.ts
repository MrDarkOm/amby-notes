/** Words of a story by day (`YYYY-MM-DD`): the count when the day began and the last one seen. */
export type WordLog = Record<string, { start: number; last: number }>

export function recordWords(_log: WordLog, _day: string, _total: number): WordLog {
  throw new Error("not implemented")
}

export function writtenOn(_log: WordLog, _day: string): number {
  throw new Error("not implemented")
}

export function streakOf(_log: WordLog, _goal: number, _today: string): number {
  throw new Error("not implemented")
}

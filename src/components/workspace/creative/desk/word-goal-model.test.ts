import { describe, expect, it } from "vitest"
import { recordWords, streakOf, writtenOn, type WordLog } from "./word-goal-model"

describe("recordWords", () => {
  it("starts a day from the last count of the day before, or from the first count seen", () => {
    let log: WordLog = {}
    log = recordWords(log, "2026-11-24", 1000)
    log = recordWords(log, "2026-11-24", 1200)
    expect(log["2026-11-24"]).toEqual({ start: 1000, last: 1200 })
    log = recordWords(log, "2026-11-25", 1250)
    expect(log["2026-11-25"]).toEqual({ start: 1200, last: 1250 })
  })

  it("keeps only the last sixty days and leaves an unchanged log as it is", () => {
    let log: WordLog = {}
    for (let day = 1; day <= 70; day += 1) {
      const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10)
      log = recordWords(log, date, day * 10)
    }
    expect(Object.keys(log)).toHaveLength(60)
    expect(log["2026-01-01"]).toBeUndefined()
    expect(recordWords(log, "2026-03-11", 700)).toBe(log)
  })
})

describe("writtenOn", () => {
  it("counts what was added that day, never less than nothing", () => {
    const log: WordLog = {
      "2026-11-24": { start: 1000, last: 1300 },
      "2026-11-25": { start: 1300, last: 1100 },
    }
    expect(writtenOn(log, "2026-11-24")).toBe(300)
    expect(writtenOn(log, "2026-11-25")).toBe(0)
    expect(writtenOn(log, "2026-11-26")).toBe(0)
  })
})

describe("streakOf", () => {
  const log: WordLog = {
    "2026-11-21": { start: 0, last: 600 },
    "2026-11-22": { start: 600, last: 700 },
    "2026-11-23": { start: 700, last: 1300 },
    "2026-11-24": { start: 1300, last: 1800 },
    "2026-11-25": { start: 1800, last: 1900 },
  }

  it("counts the days in a row that reached the goal, up to today", () => {
    expect(streakOf(log, 500, "2026-11-24")).toBe(2)
  })

  it("keeps yesterday's streak while today is not done yet, and is zero without a goal", () => {
    expect(streakOf(log, 500, "2026-11-25")).toBe(2)
    expect(streakOf(log, 500, "2026-11-27")).toBe(0)
    expect(streakOf(log, 0, "2026-11-24")).toBe(0)
  })
})

import { describe, expect, it } from "vitest"
import type { DatabaseRow, ProjectTextSummary, TextPageStat } from "@/lib/storage"
import { storySummary } from "../project-fixtures.test-support"
import { computeStoryStat, latestWork } from "./story-stats-model"

const row = (noteId: string, title: string, optionId?: string): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { st: { type: "status", optionId } } : {}),
  rowRevision: "r",
})
const stat = (
  noteId: string,
  wordCount: number,
  modified: number | null,
  created: number | null = null,
): TextPageStat => ({ noteId, wordCount, modified, created })

const text = (withStatus: boolean): ProjectTextSummary => ({
  databaseId: "db_t",
  properties: {
    level: "lv",
    parent: "pa",
    order: "or",
    format: "fm",
    status: withStatus ? "st" : null,
    anchors: null,
    arcs: null,
  },
  levels: [],
  formats: [],
  statusOptions: withStatus
    ? [
        { id: "todo", name: "Черновик", color: "gray", group: "notStarted" },
        { id: "fin", name: "Готово", color: "green", group: "done" },
      ]
    : [],
})

describe("computeStoryStat", () => {
  it("sums words, finds the latest page and the first creation time", () => {
    const result = computeStoryStat(
      storySummary("s", { text: text(true) }),
      [stat("a", 100, 10, 4), stat("b", 50, 30, 2), stat("c", 5, null, null)],
      [row("a", "Глава 1", "fin"), row("b", "Глава 2", "todo"), row("c", "Глава 3")],
    )
    expect(result).toMatchObject({
      words: 155,
      pages: 3,
      donePages: 1,
      lastModified: 30,
      lastPageId: "b",
      lastPageTitle: "Глава 2",
      lastPageWords: 50,
      created: 2,
    })
  })

  it("has no done count without a page status, and none before the rows are read", () => {
    expect(
      computeStoryStat(storySummary("s", { text: text(false) }), [stat("a", 1, 1)], [row("a", "A")])
        .donePages,
    ).toBeNull()
    const unread = computeStoryStat(
      storySummary("s", { text: text(true) }),
      [stat("a", 1, 1)],
      undefined,
    )
    expect(unread.donePages).toBeNull()
    expect(unread.pages).toBe(1)
    expect(unread.lastPageTitle).toBeNull()
  })

  it("ignores a page the index holds but the database no longer lists", () => {
    const result = computeStoryStat(
      storySummary("s"),
      [stat("a", 10, 5), stat("ghost", 999, 99)],
      [row("a", "A")],
    )
    expect(result.words).toBe(10)
    expect(result.lastPageId).toBe("a")
  })
})

describe("latestWork", () => {
  it("offers the page changed last across the stories", () => {
    const one = storySummary("one", { name: "Первая" })
    const two = storySummary("two", { name: "Вторая" })
    const base = {
      words: 0,
      pages: 1,
      donePages: null,
      lastPageWords: 7,
      created: null,
    }
    const result = latestWork([one, two], {
      one: { ...base, storyId: "one", lastModified: 10, lastPageId: "p1", lastPageTitle: "A" },
      two: { ...base, storyId: "two", lastModified: 20, lastPageId: "p2", lastPageTitle: "B" },
    })
    expect(result).toMatchObject({ pageId: "p2", pageTitle: "B", story: { storyId: "two" } })
  })

  it("is nothing when no story has a page with a time and a title", () => {
    expect(latestWork([storySummary("one")], {})).toBeNull()
    expect(
      latestWork([storySummary("one")], {
        one: {
          storyId: "one",
          words: 0,
          pages: 0,
          donePages: null,
          lastModified: null,
          lastPageId: null,
          lastPageTitle: null,
          lastPageWords: 0,
          created: null,
        },
      }),
    ).toBeNull()
  })
})

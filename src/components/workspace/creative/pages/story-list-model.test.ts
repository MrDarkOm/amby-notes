import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import {
  buildStoryEntries,
  doneOptionIds,
  filterAndSort,
  filterCounts,
  isStoryFinished,
  parseStoryFilter,
  parseStorySort,
  progressOf,
  sortEntries,
  statusPropertyOf,
  type StoryEntry,
} from "./story-list-model"
import type { StoryStat } from "./story-stats-model"
import { storySummary } from "../project-fixtures.test-support"

function entry(storyId: string, overrides: Partial<StoryEntry> = {}): StoryEntry {
  return {
    storyId,
    name: storyId,
    cardNoteId: `note_${storyId}`,
    universeId: null,
    universeName: null,
    finished: false,
    favorite: false,
    words: 0,
    pages: 0,
    donePages: null,
    lastModified: null,
    created: null,
    ...overrides,
  }
}

const status: DatabasePropertySummary = {
  propertyId: "st",
  name: "Статус",
  propertyType: "status",
  configJson: JSON.stringify({
    options: [
      { id: "draft", group: "notStarted" },
      { id: "work", group: "inProgress" },
      { id: "ready", group: "done" },
    ],
  }),
  options: [
    { optionId: "draft", name: "Черновик", color: "#aaaaaa" },
    { optionId: "work", name: "В работе", color: "#bbbbbb" },
    { optionId: "ready", name: "Готово", color: "#cccccc" },
  ],
}

const card = (optionId?: string): DatabaseRow => ({
  noteId: "n",
  title: "Карточка",
  relativePath: "n.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { st: { type: "status", optionId } } : {}),
  rowRevision: "r",
})

describe("story status", () => {
  it("finds the done group of the status property whatever the options are called", () => {
    expect([...doneOptionIds(status)]).toEqual(["ready"])
    expect(doneOptionIds(null).size).toBe(0)
    expect(statusPropertyOf([{ ...status, propertyType: "text" }, status])?.propertyId).toBe("st")
    expect(statusPropertyOf(undefined)).toBeNull()
  })

  it("calls a story finished only when its card holds a done status", () => {
    expect(isStoryFinished(card("ready"), status)).toBe(true)
    expect(isStoryFinished(card("work"), status)).toBe(false)
    expect(isStoryFinished(card(), status)).toBe(false)
    expect(isStoryFinished(undefined, status)).toBe(false)
    expect(isStoryFinished(card("ready"), null)).toBe(false)
  })
})

describe("story entries", () => {
  it("joins the catalog, the numbers, the universe and the favorites", () => {
    const stats: Record<string, StoryStat> = {
      a: {
        storyId: "a",
        words: 120,
        pages: 4,
        donePages: 1,
        lastModified: 50,
        lastPageId: "p",
        lastPageTitle: "P",
        lastPageWords: 10,
        created: 5,
      },
    }
    const entries = buildStoryEntries({
      stories: [storySummary("a"), storySummary("b")],
      stats,
      finished: (story) => story.storyId === "b",
      universeOf: (story) => (story.storyId === "a" ? "u1" : null),
      universeName: (id) => (id === "u1" ? "Мир" : null),
      favorites: new Set(["note_a"]),
    })
    expect(entries[0]).toMatchObject({
      storyId: "a",
      universeId: "u1",
      universeName: "Мир",
      favorite: true,
      finished: false,
      words: 120,
      pages: 4,
      donePages: 1,
      lastModified: 50,
      created: 5,
    })
    expect(entries[1]).toMatchObject({
      finished: true,
      favorite: false,
      words: 0,
      lastModified: null,
    })
  })

  it("measures progress: finished is whole, else done pages of all pages", () => {
    expect(progressOf(entry("a", { finished: true }))).toBe(1)
    expect(progressOf(entry("a", { pages: 4, donePages: 1 }))).toBe(0.25)
    expect(progressOf(entry("a", { pages: 4, donePages: null }))).toBe(0)
    expect(progressOf(entry("a", { pages: 0, donePages: 0 }))).toBe(0)
  })
})

describe("filtering and sorting stories", () => {
  const entries = [
    entry("a", {
      name: "Альфа",
      favorite: true,
      words: 10,
      lastModified: 100,
      created: 3,
      universeId: "u1",
    }),
    entry("b", {
      name: "Бета",
      finished: true,
      words: 500,
      lastModified: 300,
      created: 1,
      pages: 2,
    }),
    entry("c", {
      name: "Гамма",
      words: 200,
      lastModified: null,
      created: null,
      pages: 10,
      donePages: 5,
      universeId: "u1",
    }),
    entry("d", {
      name: "Дельта",
      words: 200,
      lastModified: 200,
      created: 9,
      pages: 10,
      donePages: 8,
    }),
  ]

  it("counts what each filter would show, within the world chosen", () => {
    expect(filterCounts(entries)).toEqual({ all: 4, favorites: 1, inProgress: 3, finished: 1 })
    expect(filterCounts(entries, "u1")).toEqual({
      all: 2,
      favorites: 1,
      inProgress: 2,
      finished: 0,
    })
    expect(filterCounts(entries, "standalone")).toEqual({
      all: 2,
      favorites: 0,
      inProgress: 1,
      finished: 1,
    })
  })

  it("filters by the segment and the world", () => {
    const ids = (list: StoryEntry[]) => list.map((item) => item.storyId)
    expect(ids(filterAndSort(entries, { filter: "favorites", sort: "name" }))).toEqual(["a"])
    expect(ids(filterAndSort(entries, { filter: "finished", sort: "name" }))).toEqual(["b"])
    expect(ids(filterAndSort(entries, { filter: "inProgress", sort: "name" }))).toEqual([
      "a",
      "c",
      "d",
    ])
    expect(ids(filterAndSort(entries, { filter: "all", sort: "name", world: "u1" }))).toEqual([
      "a",
      "c",
    ])
    expect(
      ids(filterAndSort(entries, { filter: "all", sort: "name", world: "standalone" })),
    ).toEqual(["b", "d"])
  })

  it("sorts by the last change, newest first, with the untouched last", () => {
    expect(sortEntries(entries, "recent").map((e) => e.storyId)).toEqual(["b", "d", "a", "c"])
  })

  it("sorts by name, words, progress and creation", () => {
    expect(sortEntries(entries, "name").map((e) => e.storyId)).toEqual(["a", "b", "c", "d"])
    // Equal words fall back to the name.
    expect(sortEntries(entries, "words").map((e) => e.storyId)).toEqual(["b", "c", "d", "a"])
    expect(sortEntries(entries, "progress").map((e) => e.storyId)).toEqual(["b", "d", "c", "a"])
    expect(sortEntries(entries, "created").map((e) => e.storyId)).toEqual(["d", "a", "b", "c"])
  })

  it("does not change the list it is given", () => {
    const before = entries.map((e) => e.storyId)
    sortEntries(entries, "words")
    expect(entries.map((e) => e.storyId)).toEqual(before)
  })

  it("reads remembered choices and drops the unknown", () => {
    expect(parseStoryFilter("finished")).toBe("finished")
    expect(parseStoryFilter("nope")).toBe("all")
    expect(parseStoryFilter(undefined)).toBe("all")
    expect(parseStorySort("words")).toBe("words")
    expect(parseStorySort(3)).toBe("recent")
  })
})

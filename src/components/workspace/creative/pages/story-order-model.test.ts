import { describe, expect, it } from "vitest"
import { orderStoryEntries, type StoryEntry } from "./story-list-model"
import { mergeStoryOrder, orderAfterMove, orderAfterStep } from "./story-order-model"

function entry(storyId: string, overrides: Partial<StoryEntry> = {}): StoryEntry {
  return {
    storyId,
    name: storyId,
    cardNoteId: `card_${storyId}`,
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

const ids = (list: StoryEntry[]) => list.map((item) => item.storyId)

describe("orderStoryEntries", () => {
  const entries = [entry("a"), entry("b"), entry("c"), entry("d")]

  it("puts the stories placed by hand first, in the order placed", () => {
    expect(ids(orderStoryEntries(entries, { manualOrder: ["card_c", "card_a"] }))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ])
  })

  it("orders the unplaced by the time their card was made, the unknown last, then by name", () => {
    const created: Record<string, number> = { card_d: 1, card_b: 2 }
    expect(
      ids(orderStoryEntries(entries, { manualOrder: [], createdOf: (id) => created[id] })),
    ).toEqual(["d", "b", "a", "c"])
  })

  it("falls back to the time of the story's first page, and places a story with no card by time", () => {
    const list = [
      entry("a", { created: 9 }),
      entry("b", { created: 3 }),
      entry("nocard", { cardNoteId: null, created: 5 }),
    ]
    expect(ids(orderStoryEntries(list, { manualOrder: [] }))).toEqual(["b", "nocard", "a"])
  })

  it("ignores a placed ID that is no story here", () => {
    expect(ids(orderStoryEntries(entries, { manualOrder: ["gone", "card_b"] }))).toEqual([
      "b",
      "a",
      "c",
      "d",
    ])
  })
})

describe("moving a story in the order", () => {
  const entries = [entry("a"), entry("b"), entry("c")]

  it("returns the whole new list of card IDs", () => {
    expect(orderAfterMove(entries, "a", 2)).toEqual(["card_b", "card_c", "card_a"])
    expect(orderAfterMove(entries, "c", 0)).toEqual(["card_c", "card_a", "card_b"])
  })

  it("clamps to the ends and says nothing changed with null", () => {
    expect(orderAfterMove(entries, "a", 99)).toEqual(["card_b", "card_c", "card_a"])
    expect(orderAfterMove(entries, "b", 1)).toBeNull()
    expect(orderAfterMove(entries, "nope", 0)).toBeNull()
  })

  it("steps one place; the ends cannot step out", () => {
    expect(orderAfterStep(entries, "b", -1)).toEqual(["card_b", "card_a", "card_c"])
    expect(orderAfterStep(entries, "b", 1)).toEqual(["card_a", "card_c", "card_b"])
    expect(orderAfterStep(entries, "a", -1)).toBeNull()
    expect(orderAfterStep(entries, "c", 1)).toBeNull()
  })

  it("does not move a story that has no card, and leaves such a story out of the saved list", () => {
    const list = [entry("a"), entry("x", { cardNoteId: null }), entry("c")]
    expect(orderAfterMove(list, "x", 0)).toBeNull()
    expect(orderAfterMove(list, "c", 0)).toEqual(["card_c", "card_a"])
  })
})

describe("mergeStoryOrder", () => {
  it("keeps other universes' places and gives the universe's own places to its new order", () => {
    expect(mergeStoryOrder(["x", "a", "y", "b", "z"], ["b", "a"])).toEqual([
      "x",
      "b",
      "y",
      "a",
      "z",
    ])
  })

  it("puts a story with no place yet after the rest, in the new order", () => {
    expect(mergeStoryOrder(["x", "a"], ["c", "a", "b"])).toEqual(["x", "c", "a", "b"])
  })

  it("starts from nothing", () => {
    expect(mergeStoryOrder([], ["a", "b"])).toEqual(["a", "b"])
  })
})

import { describe, expect, it } from "vitest"
import type { NoteReference } from "@/lib/storage"
import { orderStoryAnchors, type PageBinding } from "./plot-model"
import {
  anchorRibbon,
  arcAnchors,
  arcChapters,
  bucketAnchors,
  characterArcs,
  pageNeighbours,
  universeEvents,
  type StoryPlotText,
} from "./plot-views"
import type { Membership } from "./workshop-model"

const anchor = (noteId: string) => ({ noteId, title: noteId.toUpperCase() })
const A = anchor("a")
const B = anchor("b")
const C = anchor("c")
const D = anchor("d")

const order = ["book", "ch1", "ch2", "ch3", "ch4"]
const bind = (entries: Record<string, string[]>): Map<string, PageBinding> =>
  new Map(Object.entries(entries).map(([page, anchors]) => [page, { anchors, arcs: [] }]))
const created = () => undefined

function ordered(bindings: Map<string, PageBinding>, anchors = [A, B, C, D]) {
  return orderStoryAnchors({
    anchors,
    textOrder: order,
    bindings,
    manualOrder: [],
    createdOf: created,
  })
}

describe("pageNeighbours", () => {
  // a on ch1, b on ch3, c on ch3 and ch4, d bound to nothing ("ahead").
  const bindings = bind({ ch1: ["a"], ch3: ["b", "c"], ch4: ["c"] })
  const placed = ordered(bindings)

  it("a page with an anchor: its own, and the nearest others around it", () => {
    const result = pageNeighbours("ch3", placed, order, bindings)
    expect(result.own.map((row) => row.noteId)).toEqual(["b", "c"])
    expect(result.from?.noteId).toBe("a")
    expect(result.to).toBe(D)
    expect(result.toAhead).toBe(true)
  })

  it("a page without an anchor takes the nearest before and after", () => {
    const result = pageNeighbours("ch2", placed, order, bindings)
    expect(result.own).toEqual([])
    expect(result.from?.noteId).toBe("a")
    expect(result.to?.noteId).toBe("b")
    expect(result.toAhead).toBe(false)
  })

  it("the first page has nothing before and the last nothing after but 'ahead'", () => {
    const first = pageNeighbours("book", placed, order, bindings)
    expect(first.from).toBeNull()
    expect(first.to?.noteId).toBe("a")
    const last = pageNeighbours("ch4", placed, order, bindings)
    expect(last.own.map((row) => row.noteId)).toEqual(["c"])
    expect(last.from?.noteId).toBe("b")
    expect(last.to).toBe(D)
    expect(last.toAhead).toBe(true)
  })

  it("a parent page sees the anchors of its children as after it", () => {
    const result = pageNeighbours("book", placed, order, bindings)
    expect(result.to?.noteId).toBe("a")
  })

  it("nothing after and nothing ahead leaves 'to' empty", () => {
    const only = bind({ ch1: ["a"] })
    const result = pageNeighbours("ch4", ordered(only, [A]), order, only)
    expect(result.from?.noteId).toBe("a")
    expect(result.to).toBeNull()
    expect(result.toAhead).toBe(false)
  })

  it("a page outside the text has no neighbours", () => {
    const result = pageNeighbours("elsewhere", placed, order, bindings)
    expect(result).toEqual({ own: [], from: null, to: null, toAhead: false })
  })

  it("an anchor on several pages stands at its earliest one", () => {
    // c is on ch3 and ch4; seen from ch2 it comes after b (same page ch3, later slot).
    const result = pageNeighbours("ch2", placed, order, bindings)
    expect(result.to?.noteId).toBe("b")
    const fromEnd = pageNeighbours(
      "ch4",
      ordered(bind({ ch3: ["b", "c"], ch4: ["c"] })),
      order,
      bind({ ch3: ["b", "c"], ch4: ["c"] }),
    )
    expect(fromEnd.from?.noteId).toBe("b")
  })
})

describe("anchorRibbon", () => {
  it("lists bound anchors in text order with their first page, then the ones ahead", () => {
    const bindings = bind({ ch2: ["b"], ch1: ["a"], ch3: ["a"] })
    const items = anchorRibbon(ordered(bindings), (pageId) => pageId === "ch1")
    expect(items.map((item) => [item.row.noteId, item.pageId, item.done])).toEqual([
      ["a", "ch1", true],
      ["b", "ch2", false],
      ["c", null, false],
      ["d", null, false],
    ])
  })

  it("an anchor ahead is never passed, whatever the check says", () => {
    const items = anchorRibbon(ordered(new Map()), () => true)
    expect(items.every((item) => !item.done && item.pageId === null)).toBe(true)
  })
})

describe("bucketAnchors", () => {
  const stories: Record<string, string[]> = { a: ["s1"], b: ["s2"], c: [], d: [] }
  const membership: Membership = {
    storiesOf: (noteId) => stories[noteId] ?? [],
    universeOf: (storyId) => (storyId === "s1" ? "u1" : null),
  }
  const universes: Record<string, string | null> = { c: "u1", d: null }
  const common = {
    anchors: [D, C, B, A],
    membership,
    universeOf: (noteId: string) => universes[noteId] ?? null,
    manualOrder: ["a", "b", "c", "d"],
    createdOf: created,
  }

  it("the standalone stories: theirs in the author's order, the ones that belong nowhere last", () => {
    const result = bucketAnchors({ ...common, filter: { kind: "standalone" } })
    // "a" is in a story of the universe and "c" is an event of it: neither is shown here.
    expect(result.shown.map((row) => row.noteId)).toEqual(["b"])
    expect(result.withoutStory.map((row) => row.noteId)).toEqual(["d"])
    expect(result.events).toEqual([])
  })

  it("an anchor of a universe's story and of a standalone one is in both scopes", () => {
    const both: Membership = {
      storiesOf: (noteId) => (noteId === "a" ? ["s1", "s2"] : (stories[noteId] ?? [])),
      universeOf: membership.universeOf,
    }
    const standalone = bucketAnchors({
      ...common,
      membership: both,
      filter: { kind: "standalone" },
    })
    expect(standalone.shown.map((row) => row.noteId)).toEqual(["a", "b"])
    const universe = bucketAnchors({
      ...common,
      membership: both,
      filter: { kind: "universe", universeId: "u1" },
    })
    expect(universe.shown.map((row) => row.noteId)).toEqual(["a"])
  })

  it("a universe: its own events first, then the anchors of its stories", () => {
    const result = bucketAnchors({ ...common, filter: { kind: "universe", universeId: "u1" } })
    expect(result.events.map((row) => row.noteId)).toEqual(["c"])
    expect(result.shown.map((row) => row.noteId)).toEqual(["a"])
    expect(result.withoutStory).toEqual([])
  })

  it("an anchor of a story that is in the universe and names it is an event once", () => {
    const both = bucketAnchors({
      ...common,
      membership: { ...membership, storiesOf: (id) => (id === "c" ? ["s1"] : (stories[id] ?? [])) },
      filter: { kind: "universe", universeId: "u1" },
    })
    expect(both.events.map((row) => row.noteId)).toEqual(["c"])
    expect(both.shown.map((row) => row.noteId)).toEqual(["a"])
  })

  it("a story shows its own anchors", () => {
    const result = bucketAnchors({ ...common, filter: { kind: "story", storyId: "s2" } })
    expect(result.shown.map((row) => row.noteId)).toEqual(["b"])
  })
})

describe("universeEvents", () => {
  it("keeps the anchors that name the universe, in the author's order", () => {
    const names: Record<string, string> = { a: "u1", c: "u1", b: "u2" }
    const events = universeEvents({
      anchors: [A, B, C],
      universeId: "u1",
      universeOf: (id) => names[id] ?? null,
      manualOrder: ["c", "a"],
      createdOf: created,
    })
    expect(events.map((row) => row.noteId)).toEqual(["c", "a"])
  })
})

describe("arcs", () => {
  const house: StoryPlotText = {
    storyId: "house",
    storyName: "Дом",
    textOrder: ["h-book", "h1", "h2", "h3"],
    bindings: new Map<string, PageBinding>([
      ["h2", { anchors: ["b"], arcs: ["love"] }],
      ["h1", { anchors: ["a"], arcs: ["love", "war"] }],
      ["h3", { anchors: [], arcs: ["love"] }],
    ]),
  }
  const forest: StoryPlotText = {
    storyId: "forest",
    storyName: "Лес",
    textOrder: ["f1", "f2"],
    bindings: new Map<string, PageBinding>([["f2", { anchors: ["c"], arcs: ["love"] }]]),
  }
  const arcsOf: Record<string, string[]> = {
    a: ["love"],
    b: ["love", "war"],
    c: ["love"],
    d: ["love"],
  }

  it("the anchors of an arc go story by story in the order of each text, the unbound last", () => {
    const result = arcAnchors({
      arcId: "love",
      anchors: [D, C, B, A],
      arcsOf: (id) => arcsOf[id] ?? [],
      stories: [house, forest],
      manualOrder: [],
      createdOf: created,
    })
    expect(
      result.byStory.map((group) => [group.storyId, group.anchors.map((row) => row.noteId)]),
    ).toEqual([
      ["house", ["a", "b"]],
      ["forest", ["c"]],
    ])
    expect(result.unbound.map((row) => row.noteId)).toEqual(["d"])
  })

  it("leaves out an anchor of another arc and a story without any", () => {
    const result = arcAnchors({
      arcId: "war",
      anchors: [A, B, C],
      arcsOf: (id) => arcsOf[id] ?? [],
      stories: [house, forest],
      manualOrder: [],
      createdOf: created,
    })
    expect(result.byStory.map((group) => group.storyId)).toEqual(["house"])
    expect(result.byStory[0].anchors.map((row) => row.noteId)).toEqual(["b"])
    expect(result.unbound).toEqual([])
  })

  it("the chapters of an arc: per story in text order, with the span from first to last", () => {
    const result = arcChapters("love", [house, forest])
    expect(result).toEqual([
      {
        storyId: "house",
        storyName: "Дом",
        pageIds: ["h1", "h2", "h3"],
        span: { from: "h1", to: "h3" },
      },
      { storyId: "forest", storyName: "Лес", pageIds: ["f2"], span: null },
    ])
    expect(arcChapters("war", [house, forest]).map((entry) => entry.storyId)).toEqual(["house"])
    expect(arcChapters("none", [house, forest])).toEqual([])
  })
})

describe("characterArcs", () => {
  const reference = (over: Partial<NoteReference>): NoteReference => ({
    direction: "in",
    propertyId: "who",
    propertyName: "Персонажи",
    databaseId: "db_arcs",
    databaseName: "Арки",
    noteId: "x",
    title: "Икс",
    ...over,
  })

  it("keeps the arcs that name the character, by title", () => {
    const result = characterArcs(
      [
        reference({ noteId: "2", title: "Месть" }),
        reference({ noteId: "1", title: "Любовь" }),
        reference({ noteId: "3", propertyId: "other" }),
        reference({ noteId: "4", direction: "out" }),
        reference({ noteId: "5", title: null }),
      ],
      "who",
    )
    expect(result.map((entry) => entry.noteId)).toEqual(["1", "2"])
  })

  it("has none where the arcs name no property", () => {
    expect(characterArcs([reference({})], null)).toEqual([])
  })
})

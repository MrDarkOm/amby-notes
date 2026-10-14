import { describe, expect, it } from "vitest"
import type { DatabaseRow } from "@/lib/storage"
import { ARC_COLORS } from "@/themes/palettes"
import {
  arcColor,
  boundTo,
  decodePlotDrag,
  encodePlotDrag,
  orderStoryAnchors,
  pageMarks,
  pagesOf,
  readBindings,
  type PageBinding,
} from "./plot-model"
import { buildTextTree, textOrder } from "./text-tree-model"

const relation = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

function page(
  noteId: string,
  title: string,
  parent: string | null,
  order: string,
  links: { anchors?: string[]; arcs?: string[] } = {},
): DatabaseRow {
  const values: Record<string, unknown> = {
    lvl: { type: "select", optionId: parent ? "chapter" : "book" },
    par: relation(...(parent ? [parent] : [])),
    ord: { type: "text", value: order },
  }
  if (links.anchors) values.anc = relation(...links.anchors)
  if (links.arcs) values.arc = relation(...links.arcs)
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}

const TEXT_PROPERTIES = { level: "lvl", parent: "par", order: "ord" }
const PROPERTIES = { anchors: "anc", arcs: "arc" }

function anchor(noteId: string, title = noteId) {
  return { noteId, title }
}

describe("readBindings", () => {
  it("reads the anchors and arcs of each page and leaves out a page bound to nothing", () => {
    const rows = [
      page("a", "A", null, "a0", { anchors: ["x", "y"], arcs: ["r"] }),
      page("b", "B", null, "a1"),
      page("c", "C", null, "a2", { arcs: ["r", "s"] }),
    ]
    const bindings = readBindings(rows, PROPERTIES)
    expect([...bindings.keys()]).toEqual(["a", "c"])
    expect(boundTo(bindings, "a", "anchor")).toEqual(["x", "y"])
    expect(boundTo(bindings, "c", "arc")).toEqual(["r", "s"])
    expect(boundTo(bindings, "b", "anchor")).toEqual([])
    // A story whose text has no such property reads none.
    expect(readBindings(rows, { anchors: null, arcs: null }).size).toBe(0)
  })

  it("lists the pages an anchor is on in the order of the text", () => {
    const rows = [
      page("book1", "Книга 1", null, "a0"),
      page("book2", "Книга 2", null, "a1"),
      page("ch1", "Глава 1", "book1", "a0", { anchors: ["x"] }),
      page("ch2", "Глава 2", "book2", "a0", { anchors: ["x"] }),
      page("ch0", "Глава 0", "book1", "a1", { anchors: ["x", "y"] }),
    ]
    const roots = buildTextTree(rows, TEXT_PROPERTIES)
    const bindings = readBindings(rows, PROPERTIES)
    expect(pagesOf(bindings, textOrder(roots), "anchor", "x")).toEqual(["ch1", "ch0", "ch2"])
    expect(pagesOf(bindings, textOrder(roots), "anchor", "y")).toEqual(["ch0"])
    expect(pagesOf(bindings, textOrder(roots), "arc", "x")).toEqual([])
  })
})

describe("orderStoryAnchors", () => {
  const none = () => undefined

  it("puts an anchor where the earliest of its pages stands, depth first, whatever order it was made in", () => {
    const rows = [
      page("book1", "Книга 1", null, "a0"),
      page("book2", "Книга 2", null, "a1"),
      page("ch1", "Глава 1", "book1", "a0"),
      page("ch2", "Глава 2", "book1", "a1", { anchors: ["finale"] }),
      page("ch3", "Глава 3", "book2", "a0", { anchors: ["meeting", "finale"] }),
    ]
    const roots = buildTextTree(rows, TEXT_PROPERTIES)
    // "finale" is on chapter 2 and chapter 3: it stands at chapter 2. "meeting" is on chapter 3
    // only, after it, though it was made first.
    const result = orderStoryAnchors({
      anchors: [anchor("meeting"), anchor("finale")],
      textOrder: textOrder(roots),
      bindings: readBindings(rows, PROPERTIES),
      manualOrder: [],
      createdOf: (id) => (id === "meeting" ? 1 : 2),
    })
    expect(result.placed.map((entry) => entry.row.noteId)).toEqual(["finale", "meeting"])
    expect(result.placed[0].pageIds).toEqual(["ch2", "ch3"])
    expect(result.placed[1].pageIds).toEqual(["ch3"])
    expect(result.ahead).toEqual([])
  })

  it("lets a page that comes first in the nesting win over a later sibling's child", () => {
    const rows = [
      page("book1", "Книга 1", null, "a0"),
      page("book2", "Книга 2", null, "a1", { anchors: ["late"] }),
      page("deep", "Глубоко", "book1", "a0", { anchors: ["early"] }),
    ]
    const roots = buildTextTree(rows, TEXT_PROPERTIES)
    const result = orderStoryAnchors({
      anchors: [anchor("late"), anchor("early")],
      textOrder: textOrder(roots),
      bindings: readBindings(rows, PROPERTIES),
      manualOrder: [],
      createdOf: none,
    })
    // book1 < deep (its child) < book2 in the text.
    expect(textOrder(roots)).toEqual(["book1", "deep", "book2"])
    expect(result.placed.map((entry) => entry.row.noteId)).toEqual(["early", "late"])
  })

  it("keeps the order a page lists two of its anchors in", () => {
    const rows = [page("p", "P", null, "a0", { anchors: ["b", "a"] })]
    const roots = buildTextTree(rows, TEXT_PROPERTIES)
    const result = orderStoryAnchors({
      anchors: [anchor("a"), anchor("b")],
      textOrder: textOrder(roots),
      bindings: readBindings(rows, PROPERTIES),
      manualOrder: ["a", "b"],
      createdOf: none,
    })
    expect(result.placed.map((entry) => entry.row.noteId)).toEqual(["b", "a"])
  })

  it("leaves the anchors bound to no page ahead, in the author's order, then by time, then by title", () => {
    const rows = [page("p", "P", null, "a0", { anchors: ["bound"] })]
    const roots = buildTextTree(rows, TEXT_PROPERTIES)
    const created: Record<string, number> = { old: 1, newer: 2, tied1: 3 }
    const result = orderStoryAnchors({
      anchors: [
        anchor("tied2", "Яблоко"),
        anchor("newer"),
        anchor("bound"),
        anchor("placed2"),
        anchor("old"),
        anchor("tied1", "Арбуз"),
        anchor("placed1"),
      ],
      textOrder: textOrder(roots),
      bindings: readBindings(rows, PROPERTIES),
      manualOrder: ["placed1", "placed2"],
      createdOf: (id) => created[id],
    })
    expect(result.placed.map((entry) => entry.row.noteId)).toEqual(["bound"])
    // Placed by hand first, then made earlier, then (no time) by title.
    expect(result.ahead.map((row) => row.noteId)).toEqual([
      "placed1",
      "placed2",
      "old",
      "newer",
      "tied1",
      "tied2",
    ])
  })

  it("places an anchor of two stories by each story's own pages", () => {
    const houseRows = [
      page("h1", "Дом 1", null, "a0"),
      page("h2", "Дом 2", null, "a1", { anchors: ["shared"] }),
    ]
    const forestRows = [page("f1", "Лес 1", null, "a0")]
    const anchors = [anchor("shared"), anchor("own")]
    const at = (rows: DatabaseRow[]) =>
      orderStoryAnchors({
        anchors,
        textOrder: textOrder(buildTextTree(rows, TEXT_PROPERTIES)),
        bindings: readBindings(rows, PROPERTIES),
        manualOrder: [],
        createdOf: none,
      })
    const house = at(houseRows)
    expect(house.placed.map((entry) => entry.row.noteId)).toEqual(["shared"])
    expect(house.ahead.map((row) => row.noteId)).toEqual(["own"])
    // In the other story neither is on a page: both are ahead there.
    const forest = at(forestRows)
    expect(forest.placed).toEqual([])
    expect(forest.ahead.map((row) => row.noteId).sort()).toEqual(["own", "shared"])
  })

  it("ignores a binding to a page that is not in the text", () => {
    const rows = [page("p", "P", null, "a0")]
    const bindings = new Map<string, PageBinding>([["ghost", { anchors: ["x"], arcs: [] }]])
    const result = orderStoryAnchors({
      anchors: [anchor("x")],
      textOrder: textOrder(buildTextTree(rows, TEXT_PROPERTIES)),
      bindings,
      manualOrder: [],
      createdOf: none,
    })
    expect(result.placed).toEqual([])
    expect(result.ahead.map((row) => row.noteId)).toEqual(["x"])
  })
})

describe("pageMarks", () => {
  const titles: Record<string, string> = {
    a1: "Встреча",
    a2: "Финал",
    r1: "Любовь",
    r2: "Месть",
    r3: "Дорога",
    r4: "Тайна",
    r5: "Долг",
  }
  const titleOf = (_kind: string, id: string) => titles[id]

  it("shows no marks for a page bound to nothing, or to notes that are gone", () => {
    expect(pageMarks(undefined, titleOf)).toBeNull()
    expect(pageMarks({ anchors: [], arcs: [] }, titleOf)).toBeNull()
    expect(pageMarks({ anchors: ["gone"], arcs: ["gone"] }, titleOf)).toBeNull()
  })

  it("counts the anchors and shows up to three arcs, then how many more", () => {
    const marks = pageMarks(
      { anchors: ["a1", "a2", "gone"], arcs: ["r1", "r2", "r3", "r4", "r5"] },
      titleOf,
    )!
    expect(marks.anchorCount).toBe(2)
    expect(marks.anchorTitles).toEqual(["Встреча", "Финал"])
    expect(marks.dots.map((dot) => dot.title)).toEqual(["Любовь", "Месть", "Дорога"])
    expect(marks.more).toBe(2)
    expect(marks.arcTitles).toHaveLength(5)
    expect(pageMarks({ anchors: [], arcs: ["r1", "r2", "r3"] }, titleOf)!.more).toBe(0)
  })

  it("gives an arc the same color every time, from the palette", () => {
    const first = arcColor("01ARC")
    expect(arcColor("01ARC")).toBe(first)
    expect(ARC_COLORS).toContain(first)
    const used = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(arcColor))
    expect(used.size).toBeGreaterThan(2)
    // The same arc has the same color on two pages.
    const one = pageMarks({ anchors: [], arcs: ["r1"] }, titleOf)!
    const two = pageMarks({ anchors: [], arcs: ["r2", "r1"] }, titleOf)!
    expect(one.dots[0].color).toBe(two.dots[1].color)
  })
})

describe("the drag of an anchor or an arc", () => {
  it("round-trips and refuses what is not ours", () => {
    expect(decodePlotDrag(encodePlotDrag({ kind: "arc", id: "r1" }))).toEqual({
      kind: "arc",
      id: "r1",
    })
    for (const bad of ["", "page-id", "{}", '{"kind":"page","id":"x"}', '{"kind":"arc","id":""}']) {
      expect(decodePlotDrag(bad)).toBeNull()
    }
  })
})

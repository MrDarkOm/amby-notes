import { describe, expect, it } from "vitest"
import type { DatabaseRow } from "@/lib/storage"
import {
  buildTextTree,
  defaultLevelId,
  descendantIds,
  findNode,
  lastOrderKey,
  nodesAtLevel,
  planMove,
} from "./text-tree-model"

const PROPS = { level: "lvl", parent: "par", order: "ord" }
const LEVELS = [{ id: "book" }, { id: "chapter" }, { id: "page" }]

function row(
  noteId: string,
  level: string | null,
  parent: string | null,
  order: string | null,
  title = noteId,
): DatabaseRow {
  const values: Record<string, unknown> = {}
  if (level) values.lvl = { type: "select", optionId: level }
  if (parent) values.par = { type: "relation", targetNoteIds: [parent] }
  if (order) values.ord = { type: "text", value: order }
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

const rows = [
  row("b1", "book", null, "a0"),
  row("c2", "chapter", "b1", "a2"),
  row("c1", "chapter", "b1", "a1"),
  row("p1", "page", "c1", "a0"),
  row("b2", "book", null, "a1"),
]

describe("buildTextTree", () => {
  it("nests pages under their parents and orders siblings by their key", () => {
    const tree = buildTextTree(rows, PROPS)
    expect(tree.map((n) => n.noteId)).toEqual(["b1", "b2"])
    expect(tree[0].children.map((n) => n.noteId)).toEqual(["c1", "c2"])
    expect(tree[0].children[0].children[0].noteId).toBe("p1")
  })

  it("puts a page without a key after the keyed ones and breaks ties by note ID", () => {
    const tree = buildTextTree(
      [row("z", "book", null, null), row("a", "book", null, null), row("k", "book", null, "a5")],
      PROPS,
    )
    expect(tree.map((n) => n.noteId)).toEqual(["k", "a", "z"])
  })

  it("shows a page whose parent is gone, or that sits in a loop, at the top", () => {
    const tree = buildTextTree(
      [
        row("orphan", "page", "missing", "a0"),
        row("x", "chapter", "y", "a0"),
        row("y", "chapter", "x", "a1"),
      ],
      PROPS,
    )
    expect(tree.map((n) => n.noteId).sort()).toEqual(["orphan", "x", "y"])
  })
})

describe("levels and keys", () => {
  it("starts a page one level below its parent, or at the top level", () => {
    const tree = buildTextTree(rows, PROPS)
    expect(defaultLevelId(LEVELS, null)).toBe("book")
    expect(defaultLevelId(LEVELS, findNode(tree, "b1"))).toBe("chapter")
    expect(defaultLevelId(LEVELS, findNode(tree, "p1"))).toBe("page")
    expect(defaultLevelId([], null)).toBeNull()
  })

  it("makes a key that sorts after the last sibling", () => {
    const tree = buildTextTree(rows, PROPS)
    expect(lastOrderKey(tree) > "a1").toBe(true)
    expect(lastOrderKey([])).toBe("a0")
  })
})

describe("planMove", () => {
  const tree = buildTextTree(rows, PROPS)

  it("drops between two siblings with a key strictly between theirs", () => {
    const plan = planMove(tree, LEVELS, "c2", "c1", "before")
    expect(plan?.newParentId).toBe("b1")
    expect(plan!.orderKey < "a1").toBe(true)
  })

  it("nests inside a page on a shallower level, last among its children", () => {
    const plan = planMove(tree, LEVELS, "c2", "b2", "inside")
    expect(plan?.newParentId).toBe("b2")
  })

  it("refuses itself, its own descendants and a parent that is not shallower", () => {
    expect(planMove(tree, LEVELS, "b1", "b1", "inside")).toBeNull()
    expect(planMove(tree, LEVELS, "b1", "p1", "inside")).toBeNull()
    // A book cannot go under a chapter, a chapter not under a page of its own depth.
    expect(planMove(tree, LEVELS, "b2", "c1", "inside")).toBeNull()
    expect(planMove(tree, LEVELS, "c2", "c1", "inside")).toBeNull()
  })

  it("moves to the top level by dropping beside a top-level page", () => {
    const plan = planMove(tree, LEVELS, "c1", "b2", "after")
    expect(plan?.newParentId).toBeNull()
    expect(plan!.orderKey > "a1").toBe(true)
  })
})

describe("nodesAtLevel", () => {
  it("lists the pages of one level wherever they sit, each with what is under it", () => {
    const tree = buildTextTree(rows, PROPS)
    expect(nodesAtLevel(tree, "book").map((n) => n.noteId)).toEqual(["b1", "b2"])
    const chapters = nodesAtLevel(tree, "chapter")
    expect(chapters.map((n) => n.noteId)).toEqual(["c1", "c2"])
    expect(chapters[0].children.map((n) => n.noteId)).toEqual(["p1"])
    expect(nodesAtLevel(tree, "nope")).toEqual([])
  })
})

describe("descendantIds", () => {
  it("lists every page below a page at any depth, and none for a leaf", () => {
    const tree = buildTextTree(rows, PROPS)
    expect(descendantIds(findNode(tree, "b1")!).sort()).toEqual(["c1", "c2", "p1"])
    expect(descendantIds(findNode(tree, "c1")!)).toEqual(["p1"])
    expect(descendantIds(findNode(tree, "b2")!)).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import type { DatabaseRow } from "@/lib/storage"
import {
  ancestorIds,
  buildTextTree,
  canHaveChildPage,
  countNodes,
  defaultLevelId,
  descendantIds,
  findNode,
  lastOrderKey,
  pageStatusDotClass,
  planMove,
  resolvePageStatus,
  startLevelId,
  type TextNode,
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

/** Every page of a tree in the order it is shown, each exactly where it appears. */
function flatten(nodes: TextNode[]): string[] {
  return nodes.flatMap((node) => [node.noteId, ...flatten(node.children)])
}

describe("the whole text as one tree", () => {
  const strays = [
    ...rows,
    // A chapter made at the top of the text and a page with no level at all.
    row("loose-chapter", "chapter", null, "a2"),
    row("no-level", null, null, "a3"),
    row("dead-level", "deleted-option", null, "a4"),
  ]

  it("shows a page without a parent, or without a known level, once among the roots", () => {
    const tree = buildTextTree(strays, PROPS)
    const shown = flatten(tree)
    expect(shown.sort()).toEqual(strays.map((r) => r.noteId).sort())
    expect(new Set(shown).size).toBe(shown.length)
    expect(tree.map((n) => n.noteId)).toEqual([
      "b1",
      "b2",
      "loose-chapter",
      "no-level",
      "dead-level",
    ])
  })

  it("counts every page at any depth", () => {
    expect(countNodes(buildTextTree(rows, PROPS))).toBe(rows.length)
    expect(countNodes(buildTextTree(strays, PROPS))).toBe(strays.length)
    expect(countNodes([])).toBe(0)
  })
})

describe("canHaveChildPage", () => {
  const tree = buildTextTree(
    [...rows, row("no-level", null, null, "a3"), row("dead", "gone", null, "a4")],
    PROPS,
  )

  it("allows a page inside only above the last level of the schema", () => {
    expect(canHaveChildPage(LEVELS, findNode(tree, "b1")!)).toBe(true)
    expect(canHaveChildPage(LEVELS, findNode(tree, "c1")!)).toBe(true)
    expect(canHaveChildPage(LEVELS, findNode(tree, "p1")!)).toBe(false)
  })

  it("does not limit a page the schema does not list", () => {
    expect(canHaveChildPage(LEVELS, findNode(tree, "no-level")!)).toBe(true)
    expect(canHaveChildPage(LEVELS, findNode(tree, "dead")!)).toBe(true)
  })

  it("lets nothing go under a page of a one-level schema, but pages follow at the top", () => {
    const story = [{ id: "page" }]
    const pages = buildTextTree([row("a", "page", null, "a0"), row("b", "page", null, "a1")], PROPS)
    expect(canHaveChildPage(story, pages[0])).toBe(false)
    // New pages of such a story always start at the one level, at the top.
    expect(defaultLevelId(story, null)).toBe("page")
    // Reordering the roots works, nesting does not.
    expect(planMove(pages, story, "b", "a", "before")?.newParentId).toBeNull()
    expect(planMove(pages, story, "b", "a", "inside")).toBeNull()
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

describe("ancestorIds", () => {
  const tree = buildTextTree(rows, PROPS)

  it("lists the pages above a page, outermost first", () => {
    expect(ancestorIds(tree, "p1")).toEqual(["b1", "c1"])
    expect(ancestorIds(tree, "c2")).toEqual(["b1"])
  })

  it("is empty for a root and null for a page the tree does not hold", () => {
    expect(ancestorIds(tree, "b2")).toEqual([])
    expect(ancestorIds(tree, "nobody")).toBeNull()
  })
})

describe("startLevelId", () => {
  const levels = [
    { id: "book", state: "ok" },
    { id: "chapter", state: "dangling" },
    { id: "page", state: "ok" },
  ]
  const node = (levelId: string | null) =>
    ({
      noteId: "n",
      title: "n",
      levelId,
      statusOptionId: null,
      parentId: null,
      orderKey: null,
      revision: "r",
      children: [],
    }) as TextNode

  it("is the default level: the top one at the root, one below a parent", () => {
    expect(startLevelId(levels, null)).toBe("book")
    expect(startLevelId([{ id: "a" }, { id: "b" }], node("a"))).toBe("b")
  })

  it("skips a level the database no longer has, taking the next usable one below the parent", () => {
    expect(startLevelId(levels, node("book"))).toBe("page")
  })

  it("is null when no level is usable", () => {
    expect(startLevelId([{ id: "x", state: "dangling" }], null)).toBeNull()
    expect(startLevelId([], null)).toBeNull()
  })
})

describe("page status", () => {
  const statusOptions = [
    { id: "st_draft", name: "Черновик", color: "gray", group: "notStarted" },
    { id: "st_wip", name: "В работе", color: "amber", group: "inProgress" },
    { id: "st_done", name: "Готово", color: "green", group: "done" },
  ]

  it("extracts statusOptionId when the status property is configured", () => {
    const customRow: DatabaseRow = {
      ...row("p1", "page", null, "a0"),
      valuesJson: JSON.stringify({
        lvl: { type: "select", optionId: "page" },
        ord: { type: "text", value: "a0" },
        stat: { type: "status", optionId: "st_done" },
      }),
    }
    const tree = buildTextTree([customRow], { ...PROPS, status: "stat" })
    expect(tree[0].statusOptionId).toBe("st_done")
    expect(resolvePageStatus(statusOptions, tree[0].statusOptionId)?.group).toBe("done")
  })

  it("colors the dot by status group when status is configured, or by words when not", () => {
    expect(pageStatusDotClass(statusOptions, "st_done", 0)).toBe("bg-emerald-500")
    expect(pageStatusDotClass(statusOptions, "st_wip", 0)).toBe("bg-amber-500")
    expect(pageStatusDotClass(statusOptions, "st_draft", 500)).toBe(
      "border border-muted-foreground/50",
    )
    expect(pageStatusDotClass(statusOptions, null, 500)).toBe("border border-muted-foreground/50")
    expect(pageStatusDotClass([], null, 500)).toBe("bg-primary")
    expect(pageStatusDotClass([], null, 0)).toBe("border border-muted-foreground/50")
  })
})

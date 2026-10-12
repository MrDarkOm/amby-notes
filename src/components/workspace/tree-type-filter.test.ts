import { describe, expect, it } from "vitest"
import type { TreeItem } from "./tree/tree-types"
import { filterTreeByType, type TreeTypeKind } from "./tree-type-filter"

const item = (id: string, type: TreeItem["type"], children?: TreeItem[]): TreeItem => ({
  id,
  path: `/v/${id}`,
  name: id,
  type,
  icon: "",
  children,
})

const tree: TreeItem[] = [
  item("notes", "folder", [item("a", "file"), item("sub", "folder", [item("b", "canvas")])]),
  item("empty", "folder", []),
  item("only-canvas", "folder", [item("c", "canvas")]),
  item("db", "database", [item("row", "file")]),
  item("loose", "file"),
  item("draw", "sketch"),
]

const ids = (items: TreeItem[]): string[] =>
  items.flatMap((entry) => [entry.id, ...ids(entry.children ?? [])])

describe("filterTreeByType", () => {
  it("returns the same tree when no kind is chosen", () => {
    expect(filterTreeByType(tree, new Set())).toBe(tree)
  })

  it("keeps the matching files in their folders and drops folders with none of them", () => {
    const kinds = new Set<TreeTypeKind>(["canvas"])
    expect(ids(filterTreeByType(tree, kinds))).toEqual(["notes", "sub", "b", "only-canvas", "c"])
  })

  it("drops an empty folder and keeps the notes inside a database that is not chosen", () => {
    const kinds = new Set<TreeTypeKind>(["file"])
    const shown = ids(filterTreeByType(tree, kinds))
    expect(shown).toEqual(["notes", "a", "db", "row", "loose"])
    expect(shown).not.toContain("empty")
  })

  it("shows a chosen database without its notes when notes are not chosen", () => {
    const shown = filterTreeByType(tree, new Set<TreeTypeKind>(["database"]))
    expect(ids(shown)).toEqual(["db"])
    expect(shown[0].children).toEqual([])
  })

  it("combines kinds", () => {
    const kinds = new Set<TreeTypeKind>(["sketch", "database"])
    expect(ids(filterTreeByType(tree, kinds))).toEqual(["db", "draw"])
  })
})

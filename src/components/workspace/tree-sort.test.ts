import { describe, expect, it } from "vitest"

import type { TreeItem } from "@/lib/storage"
import {
  applyManualTreeOrder,
  reorderTreeItems,
  sortTreeItems,
  type TreeReorderPosition,
} from "./tree-sort"

function item(
  id: string,
  type: TreeItem["type"],
  options: Partial<Pick<TreeItem, "name" | "created" | "modified" | "children">> = {},
): TreeItem {
  return {
    id,
    path: `/vault/${id}`,
    name: options.name ?? id,
    type,
    created: options.created,
    modified: options.modified,
    children: options.children,
  }
}

describe("sortTreeItems", () => {
  it("preserves the current order for manual sorting", () => {
    const sorted = sortTreeItems([item("second", "file"), item("first", "file")], "manual", "asc")

    expect(sorted.map(({ id }) => id)).toEqual(["second", "first"])
  })

  it("keeps only real folders above the unified note group", () => {
    const bundleNote = item("bundle", "file", {
      name: "Zulu",
      children: [item("attachment", "canvas")],
    })
    const looseNote = item("loose", "file", { name: "Alpha" })
    const folder = item("folder", "folder", { name: "Middle" })

    const sorted = sortTreeItems([bundleNote, looseNote, folder], "name", "asc")

    expect(sorted.map(({ id }) => id)).toEqual(["folder", "loose", "bundle"])
  })

  it("keeps folders first in descending order", () => {
    const sorted = sortTreeItems(
      [
        item("alpha", "file", { name: "Alpha" }),
        item("folder", "folder", { name: "Aaron" }),
        item("zulu", "file", { name: "Zulu", children: [] }),
      ],
      "name",
      "desc",
    )

    expect(sorted.map(({ id }) => id)).toEqual(["folder", "zulu", "alpha"])
  })

  it("sorts notes with and without children together by date", () => {
    const sorted = sortTreeItems(
      [
        item("bundle", "file", { modified: 20, children: [item("layer", "canvas")] }),
        item("old", "file", { modified: 10 }),
        item("new", "file", { modified: 30 }),
        item("folder", "folder", { modified: 1 }),
      ],
      "modified",
      "desc",
    )

    expect(sorted.map(({ id }) => id)).toEqual(["folder", "new", "bundle", "old"])
  })

  it("applies the same grouping and ordering recursively", () => {
    const sorted = sortTreeItems(
      [
        item("root", "folder", {
          children: [
            item("nested-bundle", "file", {
              name: "Zulu",
              children: [item("nested-layer", "canvas")],
            }),
            item("nested-note", "file", { name: "Alpha" }),
            item("nested-folder", "folder", { name: "Middle" }),
          ],
        }),
      ],
      "name",
      "asc",
    )

    expect(sorted[0].children?.map(({ id }) => id)).toEqual([
      "nested-folder",
      "nested-note",
      "nested-bundle",
    ])
  })
})

describe("manual tree ordering", () => {
  it("restores sibling order independently at every level", () => {
    const tree = [
      item("root-a", "folder", {
        children: [item("child-a", "file"), item("child-b", "file")],
      }),
      item("root-b", "folder"),
    ]

    const ordered = applyManualTreeOrder(tree, {
      __amby_root__: ["root-b", "root-a"],
      "root-a": ["child-b", "child-a"],
    })

    expect(ordered.map(({ id }) => id)).toEqual(["root-b", "root-a"])
    expect(ordered[1]?.children?.map(({ id }) => id)).toEqual(["child-b", "child-a"])
  })

  it.each<[TreeReorderPosition, string[]]>([
    ["before", ["a", "b", "c"]],
    ["after", ["b", "a", "c"]],
    ["end", ["b", "c", "a"]],
  ])("moves a sibling %s the target", (position, expected) => {
    const reordered = reorderTreeItems(
      [item("a", "file"), item("b", "file"), item("c", "file")],
      ["a"],
      position === "end" ? null : "b",
      position,
    )

    expect(reordered.map(({ id }) => id)).toEqual(expected)
  })
})

import { describe, expect, it } from "vitest"
import {
  treeBranchGradientColor,
  flattenVisible,
  isValidTreeDropTarget,
  treeItemHasChildren,
  type TreeItem,
} from "./tree-types"

describe("flattenVisible", () => {
  const sampleTree: TreeItem[] = [
    {
      id: "folder-1",
      name: "Folder 1",
      path: "Folder 1",
      type: "folder",
      children: [
        {
          id: "note-1",
          name: "Note 1",
          path: "Folder 1/Note 1.md",
          type: "file",
        },
        {
          id: "subfolder-1",
          name: "Subfolder 1",
          path: "Folder 1/Subfolder 1",
          type: "folder",
          children: [
            {
              id: "note-2",
              name: "Note 2",
              path: "Folder 1/Subfolder 1/Note 2.md",
              type: "file",
            },
          ],
        },
      ],
    },
    {
      id: "note-root",
      name: "Root Note",
      path: "Root Note.md",
      type: "file",
    },
  ]

  it("flattens all items when closedIds is empty", () => {
    const closed = new Set<string>()
    const rows = flattenVisible(sampleTree, closed)
    expect(rows.map((r) => r.item.id)).toEqual([
      "folder-1",
      "note-1",
      "subfolder-1",
      "note-2",
      "note-root",
    ])
    expect(rows.map((r) => r.level)).toEqual([0, 1, 1, 2, 0])
    expect(rows.map((r) => r.branchIndex)).toEqual([0, 0, 0, 0, null])
  })

  it("assigns one color branch to each root folder and all of its descendants", () => {
    const rows = flattenVisible(
      [
        ...sampleTree,
        {
          id: "folder-2",
          name: "Folder 2",
          path: "Folder 2",
          type: "folder",
          children: [
            {
              id: "note-3",
              name: "Note 3",
              path: "Folder 2/Note 3.md",
              type: "file",
            },
          ],
        },
      ],
      new Set(),
    )

    expect(rows.map(({ item, branchIndex }) => [item.id, branchIndex])).toEqual([
      ["folder-1", 0],
      ["note-1", 0],
      ["subfolder-1", 0],
      ["note-2", 0],
      ["note-root", null],
      ["folder-2", 1],
      ["note-3", 1],
    ])
  })

  it("omits children of collapsed folders", () => {
    const closed = new Set<string>(["folder-1"])
    const rows = flattenVisible(sampleTree, closed)
    expect(rows.map((r) => r.item.id)).toEqual(["folder-1", "note-root"])
  })

  it("omits children of nested collapsed folders", () => {
    const closed = new Set<string>(["subfolder-1"])
    const rows = flattenVisible(sampleTree, closed)
    expect(rows.map((r) => r.item.id)).toEqual(["folder-1", "note-1", "subfolder-1", "note-root"])
  })

  it("only treats items with actual children as expandable", () => {
    const emptyFolder: TreeItem = {
      id: "empty-folder",
      name: "Empty",
      path: "Empty",
      type: "folder",
      children: [],
    }

    expect(treeItemHasChildren(emptyFolder)).toBe(false)
    expect(flattenVisible([emptyFolder], new Set())[0]?.branchIndex).toBe(0)
  })

  it("validates DnD with paths rather than unrelated ULID values", () => {
    expect(
      isValidTreeDropTarget("01-source", "/vault/Folder", "01-child", "/vault/Folder/Child"),
    ).toBe(false)
    expect(
      isValidTreeDropTarget("01-source", "/vault/Folder", "01-sibling", "/vault/Sibling"),
    ).toBe(true)
    expect(isValidTreeDropTarget("01-source", "/vault/Folder", "01-source", "/vault/Other")).toBe(
      false,
    )
    expect(
      isValidTreeDropTarget("01-source", "/vault/Source.md", "01-target", "/vault/Target.md"),
    ).toBe(true)
    expect(
      isValidTreeDropTarget(
        "01-child",
        "/vault/Target/Child.md",
        "01-target",
        "/vault/Target/Target.md",
      ),
    ).toBe(false)
  })
})

describe("treeBranchGradientColor", () => {
  it("uses the active accent for the first folder and the neighbour for the last", () => {
    expect(treeBranchGradientColor(0, 2)).toBe(
      "color-mix(in oklch, var(--tree-gradient-start) 100%, var(--tree-gradient-end) 0%)",
    )
    expect(treeBranchGradientColor(1, 2)).toBe(
      "color-mix(in oklch, var(--tree-gradient-start) 0%, var(--tree-gradient-end) 100%)",
    )
  })

  it("adds evenly spaced intermediate shades as folders are added", () => {
    expect(treeBranchGradientColor(1, 3)).toBe(
      "color-mix(in oklch, var(--tree-gradient-start) 50%, var(--tree-gradient-end) 50%)",
    )
    expect(treeBranchGradientColor(1, 4)).toBe(
      "color-mix(in oklch, var(--tree-gradient-start) 66.66666666666667%, var(--tree-gradient-end) 33.33333333333333%)",
    )
  })
})

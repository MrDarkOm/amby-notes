import { describe, expect, it } from "vitest"
import { flattenVisible, isValidTreeDropTarget, type TreeItem } from "./tree-types"

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
  })
})

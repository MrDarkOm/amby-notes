import { describe, expect, it } from "vitest"
import { findTabTreeItem, treeItemTabTarget } from "./tab-target"
import type { TreeItem } from "./sidebar-tree"

describe("treeItemTabTarget", () => {
  it("converts a file item to document target", () => {
    const item: TreeItem = {
      id: "note-1",
      path: "/vault/Note.md",
      name: "Note",
      type: "file",
    }
    expect(treeItemTabTarget(item)).toEqual({
      kind: "document",
      fileId: "note-1",
      title: "Note",
    })
  })

  it("converts a canvas item using its path", () => {
    const item: TreeItem = {
      id: "canvas:/vault/Board.canvas",
      path: "/vault/Board.canvas",
      name: "Board",
      type: "canvas",
    }
    expect(treeItemTabTarget(item)).toEqual({
      kind: "canvas",
      fileId: "/vault/Board.canvas",
      title: "Board",
    })
  })

  it("converts a database item to database target with database id", () => {
    const item: TreeItem = {
      id: "01JDATABASEULID000000000001",
      path: "/vault/Projects",
      name: "Projects",
      type: "database",
      icon: "database",
    }
    expect(treeItemTabTarget(item)).toEqual({
      kind: "database",
      fileId: "01JDATABASEULID000000000001",
      title: "Projects",
    })
  })
})

describe("findTabTreeItem", () => {
  const items: TreeItem[] = [
    {
      id: "note-1",
      path: "/vault/Note.md",
      name: "Note",
      type: "file",
    },
    {
      id: "01JDATABASEULID000000000001",
      path: "/vault/Projects",
      name: "Projects",
      type: "database",
    },
  ]

  it("finds a database tree item by id directly", () => {
    expect(findTabTreeItem(items, "01JDATABASEULID000000000001")).toBe(items[1])
  })

  it("finds a database tree item with database: prefix", () => {
    const prefixedItems: TreeItem[] = [
      {
        id: "database:01JDATABASEULID000000000001",
        path: "/vault/Projects",
        name: "Projects",
        type: "database",
      },
    ]
    expect(findTabTreeItem(prefixedItems, "01JDATABASEULID000000000001")).toBe(prefixedItems[0])
  })
})

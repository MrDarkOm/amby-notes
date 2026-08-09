import { describe, it, expect } from "vitest"
import {
  wsPathDir,
  wsPathBase,
  wsPathStem,
  isSuperNoteItem,
  canvasLayerPath,
  flattenFileItems,
  flattenTree,
  findTreeItem,
  updateInTree,
  applyIconOverrides,
} from "./workspace-tree-utils"
import type { TreeItem } from "./sidebar-tree"

// ── helpers ───────────────────────────────────────────────────────────────────

const file = (id: string, name = id, path = `/${id}.md`): TreeItem => ({
  id,
  name,
  path,
  type: "file",
  icon: "file",
})

const folder = (id: string, children: TreeItem[] = []): TreeItem => ({
  id,
  name: id,
  path: `/${id}`,
  type: "folder",
  icon: "folder",
  children,
})

// ── wsPath* ───────────────────────────────────────────────────────────────────

describe("wsPathDir", () => {
  it("returns the directory portion", () => {
    expect(wsPathDir("/vault/sub/note.md")).toBe("/vault/sub")
  })
  it("returns empty string for a filename with no directory", () => {
    expect(wsPathDir("note.md")).toBe("")
  })
  it("handles Windows backslashes (finds index via normalized path, slices original)", () => {
    // Implementation normalizes only to find the separator index, then slices the
    // original string — so the result preserves backslashes.
    expect(wsPathDir("C:\\vault\\note.md")).toBe("C:\\vault")
  })
})

describe("wsPathBase", () => {
  it("returns the filename", () => {
    expect(wsPathBase("/vault/sub/note.md")).toBe("note.md")
  })
  it("handles Windows backslashes", () => {
    expect(wsPathBase("C:\\vault\\note.md")).toBe("note.md")
  })
})

describe("wsPathStem", () => {
  it("strips the extension", () => {
    expect(wsPathStem("/vault/note.md")).toBe("note")
  })
  it("handles filenames without extension", () => {
    expect(wsPathStem("/vault/README")).toBe("README")
  })
})

describe("isSuperNoteItem", () => {
  it("recognizes a bundle's same-named main note", () => {
    expect(isSuperNoteItem({ type: "file", path: "/vault/Project/Project.md" })).toBe(true)
  })

  it("does not mark a loose note or a note in an unrelated folder as a supernote", () => {
    expect(isSuperNoteItem({ type: "file", path: "/vault/Project.md" })).toBe(false)
    expect(isSuperNoteItem({ type: "file", path: "/vault/Projects/Project.md" })).toBe(false)
  })

  it("never marks folders as supernotes", () => {
    expect(isSuperNoteItem({ type: "folder", path: "/vault/Project/Project.md" })).toBe(false)
  })
})

describe("canvasLayerPath", () => {
  it("builds the sidecar canvas path", () => {
    expect(canvasLayerPath("/vault/notes/my-note.md")).toBe("/vault/notes/my-note.canvas")
  })
})

// ── flattenFileItems ──────────────────────────────────────────────────────────

describe("flattenFileItems", () => {
  it("returns empty array for empty input", () => {
    expect(flattenFileItems([])).toEqual([])
  })

  it("collects direct file children", () => {
    const items = [file("a"), file("b")]
    expect(flattenFileItems(items).map((i) => i.id)).toEqual(["a", "b"])
  })

  it("collects nested files depth-first", () => {
    const items = [folder("dir", [file("a"), file("b")]), file("c")]
    expect(flattenFileItems(items).map((i) => i.id)).toEqual(["a", "b", "c"])
  })

  it("does not include folders", () => {
    const items = [folder("dir", [file("a")])]
    expect(flattenFileItems(items).every((i) => i.type === "file")).toBe(true)
  })
})

// ── flattenTree ───────────────────────────────────────────────────────────────

describe("flattenTree", () => {
  it("returns empty Set for empty input", () => {
    expect(flattenTree([])).toEqual(new Set())
  })

  it("collects all ids including folders and files", () => {
    const items = [folder("dir", [file("a")]), file("b")]
    const ids = flattenTree(items)
    expect(ids.has("dir")).toBe(true)
    expect(ids.has("a")).toBe(true)
    expect(ids.has("b")).toBe(true)
  })
})

// ── findTreeItem ──────────────────────────────────────────────────────────────

describe("findTreeItem", () => {
  const tree = [folder("dir", [file("a"), file("b")]), file("c")]

  it("finds a top-level item", () => {
    expect(findTreeItem(tree, "c")?.id).toBe("c")
  })

  it("finds a nested item", () => {
    expect(findTreeItem(tree, "a")?.id).toBe("a")
  })

  it("returns null for a missing id", () => {
    expect(findTreeItem(tree, "x")).toBeNull()
  })
})

// ── updateInTree ──────────────────────────────────────────────────────────────

describe("updateInTree", () => {
  it("updates a top-level item without mutating the original", () => {
    const tree = [file("a"), file("b")]
    const updated = updateInTree(tree, "a", (item) => ({ ...item, name: "A-renamed" }))
    expect(updated[0].name).toBe("A-renamed")
    expect(tree[0].name).toBe("a") // original unchanged
  })

  it("updates a nested item", () => {
    const tree = [folder("dir", [file("a")])]
    const updated = updateInTree(tree, "a", (item) => ({ ...item, name: "A-renamed" }))
    expect(updated[0].children?.[0].name).toBe("A-renamed")
  })

  it("leaves unmatched items unchanged", () => {
    const tree = [file("a"), file("b")]
    const updated = updateInTree(tree, "a", (item) => ({ ...item, name: "X" }))
    expect(updated[1].name).toBe("b")
  })
})

// ── applyIconOverrides ────────────────────────────────────────────────────────

describe("applyIconOverrides", () => {
  it("overrides an icon when the id is in the map", () => {
    const items = [file("a")]
    const result = applyIconOverrides(items, { a: "🌟" })
    expect(result[0].icon).toBe("🌟")
  })

  it("keeps the original icon when no override", () => {
    const items = [file("b")]
    const result = applyIconOverrides(items, {})
    expect(result[0].icon).toBe("file")
  })

  it("applies overrides recursively into children", () => {
    const items = [folder("dir", [file("a")])]
    const result = applyIconOverrides(items, { a: "📄" })
    expect(result[0].children?.[0].icon).toBe("📄")
  })

  it("does not mutate the original items", () => {
    const items = [file("a")]
    applyIconOverrides(items, { a: "🌟" })
    expect(items[0].icon).toBe("file")
  })
})

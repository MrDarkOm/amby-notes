import { describe, it, expect } from "vitest"
import {
  applySessionRemap,
  applyTreePatch,
  planMutation,
  remapPath,
  remapStoredId,
} from "./workspace-mutations"
import type { FsMutationResult } from "@/lib/storage"
import type { SessionFile } from "./app-config"
import type { TreeItem } from "./sidebar-tree"

// ── helpers ──────────────────────────────────────────────────────────────────

function mutation(overrides: Partial<FsMutationResult> = {}): FsMutationResult {
  return {
    pathChanges: [],
    deletedPaths: [],
    ...overrides,
  }
}

function session(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    tabs: [],
    activeFileId: "",
    favorites: [],
    viewModes: {},
    locked: [],
    icons: {},
    ...overrides,
  }
}

// ── remapPath ─────────────────────────────────────────────────────────────────

describe("remapPath", () => {
  it("returns original path when no changes", () => {
    expect(remapPath("/vault/a.md", [])).toBe("/vault/a.md")
  })

  it("returns new path for an exact match", () => {
    const changes = [{ oldPath: "/vault/a.md", newPath: "/vault/b.md" }]
    expect(remapPath("/vault/a.md", changes)).toBe("/vault/b.md")
  })

  it("returns original when no change matches", () => {
    const changes = [{ oldPath: "/vault/x.md", newPath: "/vault/y.md" }]
    expect(remapPath("/vault/a.md", changes)).toBe("/vault/a.md")
  })

  it("ignores changes with empty oldPath", () => {
    const changes = [{ oldPath: "", newPath: "/vault/new.md" }]
    expect(remapPath("", changes)).toBe("")
  })
})

// ── planMutation ──────────────────────────────────────────────────────────────

describe("planMutation", () => {
  it("reports no changes for an empty result", () => {
    const { deletedIds, hasChanges } = planMutation(mutation())
    expect(hasChanges).toBe(false)
    expect(deletedIds).toEqual([])
  })

  it("collects deletedIds from deletedPaths when deletedIds absent", () => {
    const { deletedIds, hasChanges } = planMutation(mutation({ deletedPaths: ["id1", "id2"] }))
    expect(hasChanges).toBe(true)
    expect(deletedIds).toEqual(expect.arrayContaining(["id1", "id2"]))
  })

  it("prefers deletedIds over deletedPaths when both present", () => {
    const { deletedIds } = planMutation(
      mutation({ deletedIds: ["ulid1"], deletedPaths: ["path1"] }),
    )
    // deletedIds ?? deletedPaths — only deletedIds used
    expect(deletedIds).toEqual(["ulid1"])
    expect(deletedIds).not.toContain("path1")
  })

  it("deduplicates deletedIds", () => {
    const { deletedIds } = planMutation(mutation({ deletedIds: ["a", "a", "b"] }))
    expect(deletedIds).toHaveLength(2)
    expect(deletedIds).toContain("a")
    expect(deletedIds).toContain("b")
  })

  it("remapFn maps a path through pathChanges", () => {
    const { remapFn, hasChanges } = planMutation(
      mutation({
        pathChanges: [{ oldPath: "/vault/old.md", newPath: "/vault/new.md" }],
      }),
    )
    expect(hasChanges).toBe(true)
    expect(remapFn("/vault/old.md")).toBe("/vault/new.md")
    expect(remapFn("/vault/other.md")).toBe("/vault/other.md")
  })

  it("remapFn ignores pathChanges with empty oldPath", () => {
    const { remapFn } = planMutation(
      mutation({ pathChanges: [{ oldPath: "", newPath: "/vault/new.md" }] }),
    )
    expect(remapFn("")).toBe("")
  })

  it("hasChanges is true when only pathChanges is non-empty", () => {
    const { hasChanges } = planMutation(
      mutation({
        pathChanges: [{ oldPath: "/a.md", newPath: "/b.md" }],
      }),
    )
    expect(hasChanges).toBe(true)
  })
})

// ── applyTreePatch ───────────────────────────────────────────────────────────

function tree(items: TreeItem[] = []): TreeItem[] {
  return items
}

describe("applyTreePatch", () => {
  it("inserts a newly indexed note without a full refresh", () => {
    const result = applyTreePatch(
      tree(),
      mutation({
        primaryId: "note-1",
        primaryPath: "/vault/New.md",
        pathChanges: [{ oldPath: "", newPath: "/vault/New.md" }],
      }),
    )

    expect(result).toEqual([
      expect.objectContaining({ id: "note-1", path: "/vault/New.md", name: "New", type: "file" }),
    ])
  })

  it("moves a bundle main note to its visual parent, not inside its bundle directory", () => {
    const result = applyTreePatch(
      tree([
        {
          id: "note-1",
          path: "/vault/Old/Old.md",
          name: "Old",
          type: "file",
          children: [{ id: "child", path: "/vault/Old/Child.md", name: "Child", type: "file" }],
        },
        {
          id: "folder:/vault/Target",
          path: "/vault/Target",
          name: "Target",
          type: "folder",
          children: [],
        },
      ]),
      mutation({
        primaryId: "note-1",
        primaryPath: "/vault/Target/Old/Old.md",
        pathChanges: [
          { oldPath: "/vault/Old/Old.md", newPath: "/vault/Target/Old/Old.md" },
          { oldPath: "/vault/Old/Child.md", newPath: "/vault/Target/Old/Child.md" },
        ],
      }),
    )

    const target = result.find((item) => item.path === "/vault/Target")
    expect(target?.children?.[0]).toMatchObject({ id: "note-1", path: "/vault/Target/Old/Old.md" })
    expect(target?.children?.[0].children?.[0]).toMatchObject({
      path: "/vault/Target/Old/Child.md",
    })
  })

  it("moves a folder even when it contains only one markdown note", () => {
    const result = applyTreePatch(
      tree([
        {
          id: "folder:/vault/Old",
          path: "/vault/Old",
          name: "Old",
          type: "folder",
          children: [{ id: "note-1", path: "/vault/Old/A.md", name: "A", type: "file" }],
        },
        {
          id: "folder:/vault/Target",
          path: "/vault/Target",
          name: "Target",
          type: "folder",
          children: [],
        },
      ]),
      mutation({
        primaryPath: "/vault/Target/Old",
        pathChanges: [{ oldPath: "/vault/Old/A.md", newPath: "/vault/Target/Old/A.md" }],
      }),
    )

    const target = result.find((item) => item.path === "/vault/Target")
    expect(target?.children?.[0]).toMatchObject({ path: "/vault/Target/Old", type: "folder" })
    expect(target?.children?.[0].children?.[0]).toMatchObject({ path: "/vault/Target/Old/A.md" })
  })

  it("removes a standalone canvas when it becomes a note layer", () => {
    const result = applyTreePatch(
      tree([
        {
          id: "canvas:/vault/Sketch.canvas",
          path: "/vault/Sketch.canvas",
          name: "Sketch",
          type: "canvas",
        },
      ]),
      mutation({
        primaryId: "note-1",
        primaryPath: "/vault/Sketch/Sketch.md",
        pathChanges: [
          { oldPath: "/vault/Sketch.canvas", newPath: "/vault/Sketch/Sketch.canvas" },
          { oldPath: "", newPath: "/vault/Sketch/Sketch.md" },
        ],
      }),
    )

    expect(result).toEqual([
      expect.objectContaining({ id: "note-1", path: "/vault/Sketch/Sketch.md", type: "file" }),
    ])
  })
})

// ── remapStoredId ─────────────────────────────────────────────────────────────

describe("remapStoredId", () => {
  it("returns the remapped id when present", () => {
    expect(remapStoredId("oldId", { oldId: "newId" })).toBe("newId")
  })

  it("returns the original id when not in table", () => {
    expect(remapStoredId("missingId", {})).toBe("missingId")
  })
})

// ── applySessionRemap ─────────────────────────────────────────────────────────

describe("applySessionRemap", () => {
  const allIds = new Set(["a", "b", "c"])

  it("remaps icon keys and keeps all icons regardless of allIds", () => {
    const { icons } = applySessionRemap(
      session({ icons: { oldA: "🌟", gone: "🔥" } }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(icons["a"]).toBe("🌟")
    // "gone" → still "gone" (not in pathToId), not filtered even though not in allIds
    expect(icons["gone"]).toBe("🔥")
  })

  it("remaps and filters favorites", () => {
    const { favorites } = applySessionRemap(
      session({ favorites: ["oldA", "b", "deleted"] }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(favorites).toContain("a")
    expect(favorites).toContain("b")
    expect(favorites).not.toContain("deleted")
    expect(favorites).not.toContain("oldA")
  })

  it("remaps and filters locked ids", () => {
    const { lockedFileIds } = applySessionRemap(
      session({ locked: ["oldA", "gone"] }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(lockedFileIds).toEqual(["a"])
  })

  it("remaps and filters viewModes", () => {
    const { viewModes } = applySessionRemap(
      session({ viewModes: { oldA: "source", gone: "editor" } }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(viewModes["a"]).toBe("source")
    expect(viewModes["gone"]).toBeUndefined()
  })

  it("remaps and filters tabs when restoreSession=true", () => {
    const { tabs } = applySessionRemap(
      session({
        tabs: [
          { fileId: "oldA", title: "A" },
          { fileId: "gone", title: "Gone" },
          { fileId: "b", title: "B" },
        ],
      }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.fileId)).toContain("a")
    expect(tabs.map((t) => t.fileId)).toContain("b")
    expect(tabs.map((t) => t.fileId)).not.toContain("gone")
  })

  it("returns empty tabs when restoreSession=false", () => {
    const { tabs } = applySessionRemap(
      session({ tabs: [{ fileId: "a", title: "A" }] }),
      {},
      allIds,
      false,
    )
    expect(tabs).toHaveLength(0)
  })

  it("remaps activeFileId but does NOT filter it", () => {
    // activeFileId may not be in allIds after a deletion — caller handles this
    const { activeFileId } = applySessionRemap(
      session({ activeFileId: "oldA" }),
      { oldA: "gone-file" },
      allIds,
      true,
    )
    expect(activeFileId).toBe("gone-file")
  })

  it("handles an empty session with identity pathToId", () => {
    const result = applySessionRemap(session(), {}, new Set(), true)
    expect(result.icons).toEqual({})
    expect(result.favorites).toEqual([])
    expect(result.viewModes).toEqual({})
    expect(result.lockedFileIds).toEqual([])
    expect(result.tabs).toEqual([])
    expect(result.activeFileId).toBe("")
  })
})

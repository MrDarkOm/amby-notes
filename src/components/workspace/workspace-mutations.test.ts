import { describe, it, expect } from "vitest"
import {
  applySessionRemap,
  applyTreePatch,
  insertTreeItemOptimistically,
  moveTreeItemsOptimistically,
  planMutation,
  reconcileTreeBackedTabTitles,
  removeTreeItem,
  remapPath,
  remapStoredId,
} from "./workspace-mutations"
import type { FsMutationResult } from "@/lib/storage"
import type { SessionFile } from "./app-config"
import type { TreeItem } from "./sidebar-tree"
import type { Tab } from "./use-tabs-store"

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
    schemaVersion: 1,
    tabs: [],
    activeFileId: "",
    favorites: [],
    viewModes: {},
    nestedNotesPlacements: {},
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

  it("remaps nested child paths when parent directory changes", () => {
    const changes = [{ oldPath: "/vault/Folder", newPath: "/vault/RenamedFolder" }]
    expect(remapPath("/vault/Folder/Note.md", changes)).toBe("/vault/RenamedFolder/Note.md")
    expect(remapPath("/vault/Folder/Sub/Deep.md", changes)).toBe("/vault/RenamedFolder/Sub/Deep.md")
  })

  it("handles backslash path normalization", () => {
    const changes = [{ oldPath: "\\vault\\Folder", newPath: "/vault/NewFolder" }]
    expect(remapPath("\\vault\\Folder\\Note.md", changes)).toBe("/vault/NewFolder/Note.md")
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

  it("keeps both deleted ids and paths when both are present", () => {
    const { deletedIds } = planMutation(
      mutation({ deletedIds: ["ulid1"], deletedPaths: ["path1"] }),
    )
    expect(deletedIds).toEqual(["ulid1", "path1"])
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

function documentTab(fileId: string, title: string): Tab {
  return {
    key: `tab-${fileId}`,
    kind: "document",
    fileId,
    title,
    history: [fileId],
    historyIndex: 0,
  }
}

describe("reconcileTreeBackedTabTitles", () => {
  it("updates a stable-ID tab after an external rename", () => {
    const tabs = [documentTab("note-1", "external-watch")]
    const next = reconcileTreeBackedTabTitles(tabs, [
      {
        id: "note-1",
        name: "renamed-watch",
        path: "/vault/renamed-watch.md",
        type: "file",
      },
    ])

    expect(next[0]).toMatchObject({ fileId: "note-1", title: "renamed-watch" })
    expect(next).not.toBe(tabs)
  })

  it("finds nested items and preserves the array when every title already matches", () => {
    const tabs = [documentTab("note-1", "renamed-watch")]
    const next = reconcileTreeBackedTabTitles(tabs, [
      {
        id: "folder:/vault/Folder",
        name: "Folder",
        path: "/vault/Folder",
        type: "folder",
        children: [
          {
            id: "note-1",
            name: "renamed-watch",
            path: "/vault/Folder/renamed-watch.md",
            type: "file",
          },
        ],
      },
    ])

    expect(next).toBe(tabs)
  })

  it("leaves non-tree tabs unchanged", () => {
    const graph: Tab = {
      key: "graph",
      kind: "graph",
      fileId: "graph",
      title: "Graph",
      history: [],
      historyIndex: 0,
    }

    expect(reconcileTreeBackedTabTitles([graph], [])).toEqual([graph])
  })
})

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

  it("keeps a created note visible when the index has not returned its id yet", () => {
    const result = applyTreePatch(
      [],
      mutation({
        primaryPath: "/vault/New.md",
        pathChanges: [{ oldPath: "", newPath: "/vault/New.md" }],
      }),
    )

    expect(result).toEqual([
      expect.objectContaining({ id: "/vault/New.md", path: "/vault/New.md", name: "New" }),
    ])
  })

  it("keeps a newly created child under a standalone parent note after promotion", () => {
    const parent: TreeItem = {
      id: "parent",
      path: "/vault/Parent.md",
      name: "Parent",
      type: "file",
    }
    const pending: TreeItem = {
      id: "pending:create",
      path: "/vault/Parent/Без названия.md",
      name: "Без названия",
      type: "file",
    }
    const optimistic = insertTreeItemOptimistically([parent], parent.id, pending)

    const result = applyTreePatch(
      optimistic,
      mutation({
        primaryId: "child",
        primaryPath: pending.path,
        pathChanges: [
          { oldPath: parent.path, newPath: "/vault/Parent/Parent.md" },
          { oldPath: "", newPath: pending.path },
        ],
      }),
    )

    const promotedParent = result.find((item) => item.id === parent.id)
    expect(promotedParent).toMatchObject({ path: "/vault/Parent/Parent.md" })
    expect(promotedParent?.children).toEqual([
      expect.objectContaining({ id: "child", path: pending.path, name: "Без названия" }),
    ])
  })

  it("keeps a promoted child visible when the index has not returned its id", () => {
    const parent: TreeItem = {
      id: "parent",
      path: "/vault/Parent.md",
      name: "Parent",
      type: "file",
    }
    const childPath = "/vault/Parent/Child.md"

    const result = applyTreePatch(
      [parent],
      mutation({
        primaryPath: childPath,
        pathChanges: [
          { oldPath: parent.path, newPath: "/vault/Parent/Parent.md" },
          { oldPath: "", newPath: childPath },
        ],
      }),
    )

    const promotedParent = result.find((item) => item.path === "/vault/Parent/Parent.md")
    expect(promotedParent?.children).toEqual([
      expect.objectContaining({ id: childPath, path: childPath, name: "Child" }),
    ])
  })

  it("preserves unrelated branch identities when inserting a note", () => {
    const unchanged: TreeItem = {
      id: "folder:/vault/Unchanged",
      path: "/vault/Unchanged",
      name: "Unchanged",
      type: "folder",
      children: [{ id: "old", path: "/vault/Unchanged/Old.md", name: "Old", type: "file" }],
    }
    const target: TreeItem = {
      id: "folder:/vault/Target",
      path: "/vault/Target",
      name: "Target",
      type: "folder",
      children: [],
    }

    const result = applyTreePatch(
      [unchanged, target],
      mutation({
        primaryId: "new",
        primaryPath: "/vault/Target/New.md",
        pathChanges: [{ oldPath: "", newPath: "/vault/Target/New.md" }],
      }),
    )

    expect(result.find((item) => item.id === unchanged.id)).toBe(unchanged)
    expect(result.find((item) => item.id === target.id)).not.toBe(target)
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

  it("keeps folders and nested bundles attached to their bundle note after a tree patch", () => {
    const result = applyTreePatch(
      tree([
        {
          id: "languages",
          path: "/vault/Languages/Languages.md",
          name: "Languages",
          type: "file",
          children: [
            {
              id: "finnish",
              path: "/vault/Languages/Finnish/Finnish.md",
              name: "Finnish",
              type: "file",
              children: [
                {
                  id: "folder:/vault/Languages/Finnish/Grammar",
                  path: "/vault/Languages/Finnish/Grammar",
                  name: "Grammar",
                  type: "folder",
                  children: [],
                },
                {
                  id: "word",
                  path: "/vault/Languages/Finnish/Word.md",
                  name: "Word",
                  type: "file",
                },
              ],
            },
          ],
        },
        { id: "moved", path: "/vault/Moved.md", name: "Moved", type: "file" },
      ]),
      mutation({
        primaryId: "moved",
        primaryPath: "/vault/Languages/Finnish/Moved.md",
        pathChanges: [{ oldPath: "/vault/Moved.md", newPath: "/vault/Languages/Finnish/Moved.md" }],
      }),
    )

    expect(result).toHaveLength(1)
    const languages = result[0]
    expect(languages.id).toBe("languages")
    const finnish = languages.children?.find((item) => item.id === "finnish")
    expect(finnish?.children?.map((item) => item.id)).toEqual([
      "folder:/vault/Languages/Finnish/Grammar",
      "moved",
      "word",
    ])
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

  it("moves several empty folder trees from explicit folder path changes", () => {
    const result = applyTreePatch(
      tree([
        {
          id: "folder:/vault/A",
          path: "/vault/A",
          name: "A",
          type: "folder",
          children: [
            {
              id: "folder:/vault/A/Empty",
              path: "/vault/A/Empty",
              name: "Empty",
              type: "folder",
              children: [],
            },
          ],
        },
        { id: "folder:/vault/B", path: "/vault/B", name: "B", type: "folder", children: [] },
        {
          id: "folder:/vault/Target",
          path: "/vault/Target",
          name: "Target",
          type: "folder",
          children: [],
        },
      ]),
      mutation({
        primaryPath: "/vault/Target/B",
        pathChanges: [
          { oldPath: "/vault/A", newPath: "/vault/Target/A" },
          { oldPath: "/vault/B", newPath: "/vault/Target/B" },
        ],
      }),
    )

    const target = result.find((item) => item.path === "/vault/Target")
    expect(target?.children?.map((item) => item.path)).toEqual([
      "/vault/Target/A",
      "/vault/Target/B",
    ])
    expect(target?.children?.[0].children?.[0].path).toBe("/vault/Target/A/Empty")
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

describe("moveTreeItemsOptimistically", () => {
  it("moves several selected rows under one folder without changing their paths", () => {
    const items: TreeItem[] = [
      {
        id: "source",
        path: "/vault/Source",
        name: "Source",
        type: "folder",
        children: [{ id: "nested", path: "/vault/Source/Nested.md", name: "Nested", type: "file" }],
      },
      { id: "loose", path: "/vault/Loose.md", name: "Loose", type: "file" },
      { id: "target", path: "/vault/Target", name: "Target", type: "folder", children: [] },
    ]

    const next = moveTreeItemsOptimistically(items, ["nested", "loose"], "target")

    expect(next.find((item) => item.id === "source")?.children).toEqual([])
    expect(next.find((item) => item.id === "target")?.children).toEqual([
      expect.objectContaining({ id: "nested", path: "/vault/Source/Nested.md" }),
      expect.objectContaining({ id: "loose", path: "/vault/Loose.md" }),
    ])
  })

  it("does not duplicate a selected child when its parent is selected too", () => {
    const items: TreeItem[] = [
      {
        id: "source",
        path: "/vault/Source",
        name: "Source",
        type: "folder",
        children: [{ id: "child", path: "/vault/Source/Child.md", name: "Child", type: "file" }],
      },
      { id: "target", path: "/vault/Target", name: "Target", type: "folder", children: [] },
    ]

    const next = moveTreeItemsOptimistically(items, ["source", "child"], "target")
    const moved = next.find((item) => item.id === "target")?.children ?? []

    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ id: "source", path: "/vault/Source" })
  })
})

describe("optimistic tree item lifecycle", () => {
  it("inserts and removes a pending note without cloning unrelated branches", () => {
    const unrelated: TreeItem = {
      id: "unrelated",
      path: "/vault/Unrelated",
      name: "Unrelated",
      type: "folder",
      children: [],
    }
    const target: TreeItem = {
      id: "target",
      path: "/vault/Target",
      name: "Target",
      type: "folder",
      children: [],
    }
    const pending: TreeItem = {
      id: "pending",
      path: "/vault/Target/Untitled.md",
      name: "Untitled",
      type: "file",
    }

    const inserted = insertTreeItemOptimistically([target, unrelated], "target", pending)
    expect(inserted.find((item) => item.id === "unrelated")).toBe(unrelated)
    expect(inserted.find((item) => item.id === "target")?.children).toEqual([pending])

    const finalized = applyTreePatch(
      inserted,
      mutation({
        primaryId: "created",
        primaryPath: pending.path,
        pathChanges: [{ oldPath: "", newPath: pending.path }],
      }),
    )
    expect(finalized.find((item) => item.id === "target")?.children).toEqual([
      expect.objectContaining({ id: "created", path: pending.path }),
    ])

    const removed = removeTreeItem(inserted, "pending")
    expect(removed.find((item) => item.id === "unrelated")).toBe(unrelated)
    expect(removed.find((item) => item.id === "target")?.children).toEqual([])
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

  it("remaps and filters nested-note placements", () => {
    const { nestedNotesPlacements } = applySessionRemap(
      session({ nestedNotesPlacements: { oldA: "bottom", gone: "hidden" } }),
      { oldA: "a" },
      allIds,
      true,
    )
    expect(nestedNotesPlacements).toEqual({ a: "bottom" })
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
    expect(result.contentWidths).toEqual({})
    expect(result.databaseTitleLabels).toEqual({})
    expect(result.nestedNotesPlacements).toEqual({})
    expect(result.lockedFileIds).toEqual([])
    expect(result.tabs).toEqual([])
    expect(result.activeFileId).toBe("")
    expect(result.closedTreeIds).toEqual([])
  })

  it("remaps note content widths and preserves database page keys", () => {
    const result = applySessionRemap(
      session({
        contentWidths: {
          "/vault/Note.md": "wide",
          "database:db-1": "full",
          gone: "normal",
        },
      }),
      { "/vault/Note.md": "note-1" },
      new Set(["note-1"]),
      true,
    )
    expect(result.contentWidths).toEqual({
      "note-1": "wide",
      "database:db-1": "full",
      gone: "normal",
    })
  })

  it("preserves custom database title labels", () => {
    const result = applySessionRemap(
      session({ databaseTitleLabels: { "database:db-1": "Страницы" } }),
      {},
      new Set(),
      true,
    )
    expect(result.databaseTitleLabels).toEqual({ "database:db-1": "Страницы" })
  })

  it("restores collapsed branches independently of tabs, remapping IDs and dropping missing items", () => {
    const result = applySessionRemap(
      session({ closedTreeIds: ["oldA", "folder:/vault/folder", "gone"] }),
      { oldA: "note-id" },
      new Set(["note-id", "folder:/vault/folder"]),
      false,
    )
    expect(result.closedTreeIds).toEqual(["note-id", "folder:/vault/folder"])
  })
})

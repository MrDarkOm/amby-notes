import { describe, expect, it } from "vitest"
import {
  beginLocalTreeMutation,
  filterLocalTreeWatcherChanges,
  hasActiveLocalTreeMutation,
  planOpenDocumentTreeChanges,
  recordLocalTreeMutation,
  watcherChangeAffectsDocument,
} from "./watcher-tree-reconciliation"
import type { TreeItem } from "./sidebar-tree"

const document = (path: string, title: string) => ({ path, title })

describe("watcherChangeAffectsDocument", () => {
  it("covers file, ancestor folder and vault-wide rescan events", () => {
    const path = "/vault/Notes/Note.md"
    expect(watcherChangeAffectsDocument(path, path)).toBe(true)
    expect(watcherChangeAffectsDocument(path, "/vault/Notes")).toBe(true)
    expect(watcherChangeAffectsDocument(path, "/vault/")).toBe(true)
    expect(watcherChangeAffectsDocument("C:\\vault\\Notes\\Note.md", "C:/vault/Notes/")).toBe(true)
  })

  it("does not reload siblings or similarly named folders", () => {
    expect(watcherChangeAffectsDocument("/vault/Notes/Note.md", "/vault/Notes/Other.md")).toBe(
      false,
    )
    expect(watcherChangeAffectsDocument("/vault/NotesOld/Note.md", "/vault/Notes")).toBe(false)
    expect(watcherChangeAffectsDocument("/vault2/Note.md", "/vault")).toBe(false)
  })
})

describe("local tree mutation reconciliation", () => {
  it("holds watcher refreshes while a local mutation is in flight", () => {
    const finish = beginLocalTreeMutation()
    expect(hasActiveLocalTreeMutation()).toBe(true)
    finish()
    finish()
    expect(hasActiveLocalTreeMutation()).toBe(false)
  })

  it("filters paths and parent-directory events already applied locally", () => {
    recordLocalTreeMutation(
      {
        primaryPath: "C:\\vault\\Folder\\New.md",
        pathChanges: [{ oldPath: "", newPath: "C:\\vault\\Folder\\New.md" }],
        deletedPaths: [],
      },
      10_000,
    )

    expect(
      filterLocalTreeWatcherChanges(
        [
          { kind: "create", path: "C:/vault/Folder/New.md", duringLocalMutation: true },
          { kind: "modify", path: "C:/vault/Folder", duringLocalMutation: true },
          { kind: "modify", path: "C:/vault/External.md", duringLocalMutation: true },
        ],
        10_100,
      ),
    ).toEqual([{ kind: "modify", path: "C:/vault/External.md", duringLocalMutation: true }])
  })

  it("does not hide an event received after the local operation finished", () => {
    recordLocalTreeMutation(
      {
        primaryPath: "/vault/Current.md",
        pathChanges: [{ oldPath: "", newPath: "/vault/Current.md" }],
        deletedPaths: [],
      },
      15_000,
    )

    expect(
      filterLocalTreeWatcherChanges(
        [{ kind: "modify", path: "/vault/Current.md", duringLocalMutation: false }],
        15_100,
      ),
    ).toHaveLength(1)
  })

  it("lets a delayed watcher event through after the local mutation expires", () => {
    recordLocalTreeMutation(
      {
        primaryPath: "/vault/Expired.md",
        pathChanges: [{ oldPath: "", newPath: "/vault/Expired.md" }],
        deletedPaths: [],
      },
      20_000,
    )

    expect(
      filterLocalTreeWatcherChanges(
        [{ kind: "modify", path: "/vault/Expired.md", duringLocalMutation: true }],
        22_001,
      ),
    ).toHaveLength(1)
  })
})

describe("planOpenDocumentTreeChanges", () => {
  it("classifies a rename out of the vault as deletion when its stable ID disappears", () => {
    expect(
      planOpenDocumentTreeChanges({ "note-1": document("/vault/Moved/Note.md", "Note") }, []),
    ).toEqual([{ kind: "deleted", fileId: "note-1" }])
  })

  it("classifies a stable-ID rename or move as relocation", () => {
    const tree: TreeItem[] = [
      {
        id: "folder",
        name: "Folder",
        path: "/vault/Folder",
        type: "folder",
        children: [
          {
            id: "note-1",
            name: "Renamed",
            path: "/vault/Folder/Renamed.md",
            type: "file",
          },
        ],
      },
    ]

    expect(
      planOpenDocumentTreeChanges({ "note-1": document("/vault/Note.md", "Note") }, tree),
    ).toEqual([
      {
        kind: "relocated",
        fileId: "note-1",
        path: "/vault/Folder/Renamed.md",
        title: "Renamed",
      },
    ])
  })

  it("does nothing when path and title already match", () => {
    const tree: TreeItem[] = [{ id: "note-1", name: "Note", path: "/vault/Note.md", type: "file" }]
    expect(
      planOpenDocumentTreeChanges({ "note-1": document("/vault/Note.md", "Note") }, tree),
    ).toEqual([])
  })
})

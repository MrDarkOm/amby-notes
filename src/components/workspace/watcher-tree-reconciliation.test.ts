import { describe, expect, it } from "vitest"
import {
  planOpenDocumentTreeChanges,
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

import { describe, expect, it } from "vitest"
import type { DatabaseSummary, TreeItem } from "@/lib/storage"
import { findDocumentDatabaseLayer } from "./document-database-layer"

describe("findDocumentDatabaseLayer", () => {
  const document = { id: "open-buffer", path: "/vault/Tasks.md", noteId: "stable-note" }
  const database: DatabaseSummary = {
    databaseId: "tasks",
    title: "Tasks",
    icon: null,
    attachedNoteId: "stable-note",
    manifestRevision: "revision",
    locked: false,
    properties: [],
    views: [],
    templates: [],
    diagnostics: [],
  }
  const treeItem: TreeItem = {
    id: "stable-note",
    path: "/vault/Tasks/Tasks.md",
    name: "Tasks",
    type: "file",
    bundleMembers: [
      { id: "tasks", path: "/vault/Tasks/Tasks.json", name: "Tasks", type: "database" },
    ],
  }

  it("resolves a new database while the open buffer and catalog still reflect the old note", () => {
    expect(findDocumentDatabaseLayer([], document, treeItem)).toEqual({
      databaseId: "tasks",
      title: "Tasks",
      icon: null,
      attachedNoteId: "stable-note",
    })
  })

  it("uses the catalog metadata when the attachment is found by the note's durable ID", () => {
    expect(findDocumentDatabaseLayer([database], document, null)).toBe(database)
  })
})

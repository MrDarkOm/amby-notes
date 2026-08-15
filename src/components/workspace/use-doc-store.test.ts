import { beforeEach, describe, expect, it } from "vitest"
import { useDocStore } from "./use-doc-store"

describe("useDocStore external conflicts", () => {
  beforeEach(() => {
    useDocStore.setState({ openDocs: {}, unsavedFileIds: new Set(), externalConflicts: {} })
  })

  it("tracks a conflict independently from the dirty marker", () => {
    const store = useDocStore.getState()
    store.setDoc("note", {
      id: "note",
      title: "Note",
      content: "local",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/vault/Note.md",
    })
    store.markUnsaved("note")
    store.setExternalConflict({
      fileId: "note",
      path: "/vault/Note.md",
      localContent: "local",
      externalContent: "external",
    })

    expect(useDocStore.getState().unsavedFileIds).toEqual(new Set(["note"]))
    expect(useDocStore.getState().externalConflicts.note?.externalContent).toBe("external")

    useDocStore.getState().clearExternalConflict("note")
    expect(useDocStore.getState().externalConflicts).toEqual({})
  })
})

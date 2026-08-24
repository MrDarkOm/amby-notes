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

  it("remaps external conflict path when applyMutation runs", () => {
    const store = useDocStore.getState()
    store.setDoc("survivor", {
      id: "survivor",
      title: "Survivor",
      content: "local",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/vault/Old.md",
    })
    store.setDoc("deleted", {
      id: "deleted",
      title: "Deleted",
      content: "local",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/vault/Deleted.md",
    })
    store.setExternalConflict({
      fileId: "survivor",
      path: "/vault/Old.md",
      localContent: "local",
      externalContent: "external",
    })
    store.setExternalConflict({
      fileId: "deleted",
      path: "/vault/Deleted.md",
      localContent: "local",
      externalContent: "external",
    })

    store.applyMutation(["deleted"], (p) => (p === "/vault/Old.md" ? "/vault/New.md" : p))

    const state = useDocStore.getState()
    expect(state.externalConflicts.deleted).toBeUndefined()
    expect(state.externalConflicts.survivor).toEqual({
      fileId: "survivor",
      path: "/vault/New.md",
      localContent: "local",
      externalContent: "external",
    })
  })

  it("evicts only clean buffers after tab usage has been released", () => {
    const store = useDocStore.getState()
    for (const fileId of ["clean", "dirty", "conflicted"]) {
      store.setDoc(fileId, {
        id: fileId,
        title: fileId,
        content: "content",
        created: "",
        modified: "",
        wordCount: 1,
        path: `/vault/${fileId}.md`,
      })
    }
    store.markUnsaved("dirty")
    store.setExternalConflict({
      fileId: "conflicted",
      path: "/vault/conflicted.md",
      localContent: "content",
      externalContent: "external",
    })

    store.evictCleanDocs(["clean", "dirty", "conflicted"])

    expect(useDocStore.getState().openDocs).toEqual({
      dirty: expect.any(Object),
      conflicted: expect.any(Object),
    })
  })
})

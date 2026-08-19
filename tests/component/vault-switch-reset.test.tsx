// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest"
import { act } from "@testing-library/react"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { saveRecoveryDraft, readRecoveryDraft, discardRecoveryDraft } from "@/lib/recovery-drafts"

describe("Vault switch state reset component lifecycle", () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useDocStore.getState().clearDocs()
    })
  })

  it("resets all open docs, dirty flags, and external conflicts on vault unload/switch", () => {
    act(() => {
      useDocStore.getState().setDoc("note-1", {
        id: "note-1",
        path: "vault1/note1.md",
        content: "Vault 1 content",
        isDirty: true,
        viewMode: "live",
      })
      useDocStore.getState().setDoc("note-2", {
        id: "note-2",
        path: "vault1/note2.md",
        content: "Vault 1 note 2",
        isDirty: false,
        viewMode: "source",
      })
      useDocStore.getState().markUnsaved("note-1")
      useDocStore.getState().setExternalConflict({
        fileId: "note-1",
        path: "vault1/note1.md",
        localContent: "Local content",
        externalContent: "External content",
      })
    })

    expect(Object.keys(useDocStore.getState().openDocs)).toHaveLength(2)
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
    expect(Object.keys(useDocStore.getState().externalConflicts)).toHaveLength(1)

    // Simulate vault switch: clearDocs() is invoked
    act(() => {
      useDocStore.getState().clearDocs()
    })

    expect(Object.keys(useDocStore.getState().openDocs)).toHaveLength(0)
    expect(useDocStore.getState().unsavedFileIds.size).toBe(0)
    expect(Object.keys(useDocStore.getState().externalConflicts)).toHaveLength(0)
  })

  it("saves, reads, and discards crash recovery drafts cleanly", async () => {
    await saveRecoveryDraft("note-1", "Draft in Vault A")
    await saveRecoveryDraft("note-2", "Draft in Vault B")

    const draft1 = await readRecoveryDraft("note-1")
    expect(draft1?.content).toBe("Draft in Vault A")

    const draft2 = await readRecoveryDraft("note-2")
    expect(draft2?.content).toBe("Draft in Vault B")

    await discardRecoveryDraft("note-1")
    expect(await readRecoveryDraft("note-1")).toBeNull()
    expect(await readRecoveryDraft("note-2")).not.toBeNull()
  })
})

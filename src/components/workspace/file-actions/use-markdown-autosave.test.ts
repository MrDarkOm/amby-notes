// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocStore, type Document } from "../use-doc-store"
import { beginPropertyMutation } from "../note-mutation-queue"
import { useMarkdownAutosave } from "./use-markdown-autosave"
import * as storage from "@/lib/storage"
import * as recoveryDrafts from "@/lib/recovery-drafts"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useNoticeToastStore } from "../notices/use-notice-toasts-store"
import {
  clearSourceRewriteSnapshots,
  pendingSourceRewriteSnapshot,
  requestSourceRewriteSnapshot,
} from "../autosave/source-rewrite"

describe("useMarkdownAutosave", () => {
  beforeEach(() => {
    useDocStore.setState({
      openDocs: {},
      unsavedFileIds: new Set(),
      externalConflicts: {},
    })
  })

  afterEach(() => {
    cleanup()
    clearSourceRewriteSnapshots()
    vi.restoreAllMocks()
    useDocStore.setState({
      openDocs: {},
      unsavedFileIds: new Set(),
      externalConflicts: {},
    })
  })

  it("publishes a successful save revision before slow property loading completes", async () => {
    const doc: Document = {
      id: "note-1",
      title: "Note",
      path: "/vault/Note.md",
      content: "saved",
      source: "saved",
      revision: "before",
      created: "",
      modified: "",
      wordCount: 1,
    }
    useDocStore.getState().setDoc(doc.id, doc)
    vi.spyOn(storage, "writeNote").mockResolvedValue({
      path: doc.path,
      revision: "after",
      indexState: "healthy",
      warnings: [],
    })
    let finishProperties!: () => void
    vi.spyOn(storage, "getNoteProperties").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProperties = () =>
            resolve({ hasFrontmatter: false, properties: [], customProperties: [] })
        }),
    )
    const { result } = renderHook(() =>
      useMarkdownAutosave({
        vault: "/vault",
        autosaveGeneration: 1,
        backendGeneration: 1,
        windowLabel: "main",
        applyMutationResult: vi.fn(),
      }),
    )
    act(() => result.current.handleContentChange(doc.id, "new text"))
    let saving!: Promise<void>
    act(() => {
      saving = result.current.autosave.flush(result.current.autosaveKey(doc.id))
    })
    await vi.waitFor(() => expect(useDocStore.getState().openDocs[doc.id].revision).toBe("after"))
    expect(result.current.autosave.inspect(result.current.autosaveKey(doc.id))?.inFlight).toBe(true)
    act(() => result.current.handleContentChange(doc.id, "newer unsaved text"))
    expect(useDocStore.getState().unsavedFileIds.has(doc.id)).toBe(true)
    // Finish only the first save, leaving the newer edit queued.
    result.current.autosave.pause(result.current.autosaveKey(doc.id))
    await act(async () => {
      finishProperties()
      await saving
    })
    expect(useDocStore.getState().openDocs[doc.id].content).toBe("newer unsaved text")
    expect(useDocStore.getState().unsavedFileIds.has(doc.id)).toBe(true)
    result.current.autosave.cancelGeneration(1)
  })

  it("does not replace a newly edited property with an older autosave read", async () => {
    const old = {
      hasFrontmatter: true,
      properties: [{ key: "Status", value: "old", valueKind: "text" }],
      customProperties: [],
    }
    const next = { ...old, properties: [{ key: "Status", value: "new", valueKind: "text" }] }
    const doc: Document = {
      id: "note-race",
      title: "Note",
      path: "/vault/Note.md",
      content: "saved",
      source: "saved",
      revision: "before",
      created: "",
      modified: "",
      wordCount: 1,
      noteProperties: old,
    }
    useDocStore.getState().setDoc(doc.id, doc)
    vi.spyOn(storage, "writeNote").mockResolvedValue({
      path: doc.path,
      revision: "after",
      indexState: "healthy",
      warnings: [],
    })
    let finishRead!: () => void
    vi.spyOn(storage, "getNoteProperties").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = () => resolve(old)
        }),
    )
    const { result } = renderHook(() =>
      useMarkdownAutosave({
        vault: "/vault",
        autosaveGeneration: 19,
        backendGeneration: 1,
        windowLabel: "main",
        applyMutationResult: vi.fn(),
      }),
    )
    act(() => result.current.handleContentChange(doc.id, "new body"))
    let saving!: Promise<void>
    act(() => {
      saving = result.current.autosave.flush(result.current.autosaveKey(doc.id))
    })
    await vi.waitFor(() => expect(finishRead).toBeDefined())
    const mutation = beginPropertyMutation(19, doc.id)
    act(() => useDocStore.getState().patchDoc(doc.id, { noteProperties: next }))
    await act(async () => {
      finishRead()
      await saving
    })
    mutation.finish()
    expect(useDocStore.getState().openDocs[doc.id].noteProperties).toEqual(next)
    expect(useDocStore.getState().openDocs[doc.id].content).toBe("new body")
    result.current.autosave.cancelGeneration(19)
  })

  it("asks for a history snapshot on the save that follows a source rewrite, once", async () => {
    const doc: Document = {
      id: "note-1",
      title: "Note",
      path: "/vault/Note.md",
      content: "* * *",
      source: "* * *",
      revision: "before",
      created: "",
      modified: "",
      wordCount: 1,
      noteId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }
    useDocStore.getState().setDoc(doc.id, doc)
    const writeNote = vi.spyOn(storage, "writeNote")
    writeNote.mockRejectedValueOnce(new Error("disk full"))
    writeNote.mockResolvedValue({
      path: doc.path,
      revision: "after",
      indexState: "healthy",
      warnings: [],
    })
    vi.spyOn(storage, "getNoteProperties").mockResolvedValue({
      hasFrontmatter: false,
      properties: [],
      customProperties: [],
    })
    const { result } = renderHook(() =>
      useMarkdownAutosave({
        vault: "/vault",
        autosaveGeneration: 1,
        backendGeneration: 1,
        windowLabel: "main",
        applyMutationResult: vi.fn(),
      }),
    )
    const key = result.current.autosaveKey(doc.id)
    const options = () => writeNote.mock.lastCall?.[7]

    // The editor rewrote a block: the request is keyed by the document, not the note ID.
    requestSourceRewriteSnapshot(doc.id)
    act(() => result.current.handleContentChange(doc.id, "---\n\nmore"))
    await act(async () => {
      await result.current.autosave.flush(key).catch(() => undefined)
    })
    expect(writeNote).toHaveBeenCalledTimes(1)
    expect(options()).toEqual({ rewritesSource: true })
    // The save failed, so the retry still carries the request.
    expect(pendingSourceRewriteSnapshot(doc.id)).not.toBeNull()

    act(() => result.current.handleContentChange(doc.id, "---\n\nmore text"))
    await act(async () => {
      await result.current.autosave.flush(key)
    })
    expect(options()).toEqual({ rewritesSource: true })
    expect(pendingSourceRewriteSnapshot(doc.id)).toBeNull()

    // Ordinary saves afterwards are coalesced by the backend as before.
    act(() => result.current.handleContentChange(doc.id, "---\n\nmore text again"))
    await act(async () => {
      await result.current.autosave.flush(key)
    })
    expect(options()).toBeUndefined()
    result.current.autosave.cancelGeneration(1)
  })

  it("does not mark document unsaved or schedule autosave when content is identical", () => {
    const doc: Document = {
      id: "note-1",
      title: "Note 1",
      content: "Hello world",
      created: "",
      modified: "",
      wordCount: 2,
      path: "/vault/note-1.md",
      revision: "rev-1",
      source: "Hello world",
    }
    useDocStore.getState().setDoc("note-1", doc)

    const { result } = renderHook(() =>
      useMarkdownAutosave({
        vault: "/vault",
        autosaveGeneration: 1,
        backendGeneration: 1,
        windowLabel: "main",
        applyMutationResult: vi.fn(),
      }),
    )

    act(() => {
      result.current.handleContentChange("note-1", "Hello world")
    })

    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(false)
    const pending = result.current.autosave.inspect(result.current.autosaveKey("note-1"))
    expect(pending?.dirty).toBeFalsy()
  })

  it("marks document unsaved and schedules autosave when content actually changes", () => {
    const doc: Document = {
      id: "note-1",
      title: "Note 1",
      content: "Hello world",
      created: "",
      modified: "",
      wordCount: 2,
      path: "/vault/note-1.md",
      revision: "rev-1",
      source: "Hello world",
    }
    useDocStore.getState().setDoc("note-1", doc)

    const { result } = renderHook(() =>
      useMarkdownAutosave({
        vault: "/vault",
        autosaveGeneration: 1,
        backendGeneration: 1,
        windowLabel: "main",
        applyMutationResult: vi.fn(),
      }),
    )

    act(() => {
      result.current.handleContentChange("note-1", "Hello world (edited)")
    })

    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
    expect(useDocStore.getState().openDocs["note-1"]?.content).toBe("Hello world (edited)")
    const pending = result.current.autosave.inspect(result.current.autosaveKey("note-1"))
    expect(pending?.dirty).toBe(true)
  })

  describe("a failed autosave of a note that is no longer open (docs/notices.md, step 2)", () => {
    const closedDoc: Document = {
      id: "note-1",
      title: "идея",
      content: "saved",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/vault/Заметки/идея.md",
      revision: "rev-1",
      source: "saved",
    }

    function mountAutosave() {
      useDocStore.getState().setDoc(closedDoc.id, closedDoc)
      return renderHook(() =>
        useMarkdownAutosave({
          vault: "/vault",
          autosaveGeneration: 1,
          backendGeneration: 1,
          windowLabel: "main",
          applyMutationResult: vi.fn(),
        }),
      )
    }

    /** Edits the note, closes it while the save is in flight, and lets the save fail. */
    async function failWhileClosed(result: ReturnType<typeof mountAutosave>["result"]) {
      let fail!: (error: Error) => void
      vi.spyOn(storage, "writeNote").mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
      )
      act(() => result.current.handleContentChange(closedDoc.id, "new text"))
      let saving!: Promise<void>
      act(() => {
        saving = result.current.autosave.flush(result.current.autosaveKey(closedDoc.id))
      })
      await vi.waitFor(() => expect(storage.writeNote).toHaveBeenCalled())
      act(() => useDocStore.getState().dropDocs([closedDoc.id]))
      await act(async () => {
        fail(new Error("disk full"))
        await saving.catch(() => {})
      })
    }

    beforeEach(() => {
      useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
      useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
    })

    it("does not open a window: it is a record of danger in the centre and a toast", async () => {
      const { result } = mountAutosave()
      await failWhileClosed(result)
      expect(useNoteNoticesStore.getState().closedSaveFailed).toEqual({
        "note-1": { name: "идея", path: "Заметки/идея.md" },
      })
      const [toast] = useNoticeToastStore.getState().toasts
      expect(toast).toMatchObject({
        id: "closed-save-failed:note-1",
        level: "danger",
        target: { kind: "note", id: "note-1" },
      })
      result.current.autosave.cancelGeneration(1)
    })

    it("keeps the recovery draft: nothing discards it until the save has gone through", async () => {
      const discard = vi.spyOn(recoveryDrafts, "discardRecoveryDraft")
      const { result } = mountAutosave()
      await failWhileClosed(result)
      expect(discard).not.toHaveBeenCalled()
      result.current.autosave.cancelGeneration(1)
    })

    it("takes the record and the toast away once the save has gone through", async () => {
      const { result } = mountAutosave()
      await failWhileClosed(result)
      vi.spyOn(storage, "writeNote").mockResolvedValue({
        path: closedDoc.path,
        revision: "after",
        indexState: "healthy",
        warnings: [],
      })
      await act(async () => {
        result.current.autosave.enqueueImmediate(result.current.autosaveKey(closedDoc.id), {
          fileId: closedDoc.id,
          path: closedDoc.path,
          content: "new text",
          backendGeneration: 1,
          expectedRevision: "rev-1",
        })
        await result.current.autosave.flush(result.current.autosaveKey(closedDoc.id))
      })
      expect(useNoteNoticesStore.getState().closedSaveFailed).toEqual({})
      expect(useNoticeToastStore.getState().toasts).toEqual([])
      result.current.autosave.cancelGeneration(1)
    })

    it("leaves a note that is still open to its own card and does not add a record", async () => {
      const { result } = mountAutosave()
      vi.spyOn(storage, "writeNote").mockRejectedValue(new Error("disk full"))
      act(() => result.current.handleContentChange(closedDoc.id, "new text"))
      await act(async () => {
        await result.current.autosave
          .flush(result.current.autosaveKey(closedDoc.id))
          .catch(() => {})
      })
      expect(useNoteNoticesStore.getState().saveFailed[closedDoc.id]).toBe(true)
      expect(useNoteNoticesStore.getState().closedSaveFailed).toEqual({})
      expect(useNoticeToastStore.getState().toasts).toEqual([])
      result.current.autosave.cancelGeneration(1)
    })
  })
})

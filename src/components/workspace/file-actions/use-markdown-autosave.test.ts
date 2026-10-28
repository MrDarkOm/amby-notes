// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocStore, type Document } from "../use-doc-store"
import { beginPropertyMutation } from "../note-mutation-queue"
import { useMarkdownAutosave } from "./use-markdown-autosave"
import * as storage from "@/lib/storage"
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
})

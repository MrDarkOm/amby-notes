// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocStore, type Document } from "../use-doc-store"
import { useMarkdownAutosave } from "./use-markdown-autosave"

describe("useMarkdownAutosave", () => {
  beforeEach(() => {
    useDocStore.setState({
      openDocs: {},
      unsavedFileIds: new Set(),
      externalConflicts: {},
    })
  })

  afterEach(() => {
    useDocStore.setState({
      openDocs: {},
      unsavedFileIds: new Set(),
      externalConflicts: {},
    })
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

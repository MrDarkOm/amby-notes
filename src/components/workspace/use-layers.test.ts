// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadNoteLayerContent, useLayers } from "./use-layers"
import * as storage from "@/lib/storage"
import { useViewStateStore } from "./use-view-state-store"
import type { Document } from "./use-doc-store"
import { registerEditorSerialization } from "./tiptap/editor-serialization-lifecycle"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("loadNoteLayerContent", () => {
  it("strips amby-id frontmatter from content and preserves source", async () => {
    const rawNote = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n"
    vi.spyOn(storage, "readFile").mockResolvedValue(rawNote)

    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md")

    expect(result.content).toBe("")
    expect(result.source).toBe(rawNote)
    expect(result.noteId).toBe("01M2G6775PZPKWZ4CFKBAV0AA")
    expect(result.revision).toBeDefined()
  })

  it("extracts noteId and body text when note has content", async () => {
    const rawNote = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n# Tasks\n\n- Task 1"
    vi.spyOn(storage, "readFile").mockResolvedValue(rawNote)

    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md")

    expect(result.content).toBe("# Tasks\n\n- Task 1")
    expect(result.source).toBe(rawNote)
    expect(result.noteId).toBe("01M2G6775PZPKWZ4CFKBAV0AA")
  })
})

describe("layer switching", () => {
  const doc: Document = {
    id: "note-id",
    title: "Note",
    path: "/vault/Note/Note.md",
    content: "# Note",
    source: "# Note",
    created: "",
    modified: "",
    wordCount: 1,
  }
  const layers = { note: true, sketch: true, canvas: true, database: false }

  beforeEach(() => {
    useViewStateStore.setState({ activeLayers: {}, linkedLayersByDoc: {} })
    vi.spyOn(storage, "noteLayers").mockResolvedValue(layers)
    vi.spyOn(storage, "createLayer").mockResolvedValue({
      kind: "sketch",
      notePath: doc.path,
      layerPath: "/vault/Note/Note.excalidraw",
      pathChanges: [],
    })
  })

  function setup() {
    const refreshTree = vi.fn().mockResolvedValue([])
    const applyMutationResult = vi.fn()
    const hook = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: false,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [],
        refreshTree,
        applyMutationResult,
      }),
    )
    return { ...hook, refreshTree, applyMutationResult }
  }

  it("switches repeatedly to cached sketch and canvas layers without rebuilding the tree", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, layers)
    const { result, refreshTree, applyMutationResult } = setup()
    const flush = vi.fn()
    const unregister = registerEditorSerialization({ flush })
    try {
      for (const layer of ["sketch", "canvas", "sketch"] as const) {
        await act(() => result.current.handleLayerChange(layer))
        expect(useViewStateStore.getState().activeLayers[doc.id]).toBe(layer)
      }
      expect(flush).toHaveBeenCalledTimes(3)
      expect(storage.createLayer).not.toHaveBeenCalled()
      expect(storage.noteLayers).not.toHaveBeenCalled()
      expect(refreshTree).not.toHaveBeenCalled()
      expect(applyMutationResult).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it("reads unknown layer presence and opens an existing sketch without a mutation", async () => {
    // The initial layer lookup is still pending when the user switches.
    vi.mocked(storage.noteLayers).mockImplementationOnce(() => new Promise(() => {}))
    const { result, refreshTree } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("sketch")
    expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]).toEqual(layers)
    expect(storage.createLayer).not.toHaveBeenCalled()
    expect(refreshTree).not.toHaveBeenCalled()
  })

  it("creates a missing sketch and refreshes the tree before activating it", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, sketch: false })
    const { result, refreshTree, applyMutationResult } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(storage.createLayer).toHaveBeenCalledWith(doc.path, "sketch")
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(applyMutationResult).toHaveBeenCalledTimes(1)
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("sketch")
    expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]?.sketch).toBe(true)
  })

  it("keeps the current layer when creation fails", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, sketch: false })
    useViewStateStore.getState().setActiveLayer(doc.id, "editor")
    vi.mocked(storage.createLayer).mockRejectedValue(new Error("write failed"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, refreshTree, applyMutationResult } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("editor")
    expect(refreshTree).not.toHaveBeenCalled()
    expect(applyMutationResult).not.toHaveBeenCalled()
  })
})

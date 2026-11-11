// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadNoteLayerContent, useLayers } from "./use-layers"
import * as storage from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { useViewStateStore } from "./use-view-state-store"
import { useDatabaseStore } from "./database/database-store"
import { useDocStore } from "./use-doc-store"
import type { Document } from "./use-doc-store"
import { hasActiveLocalTreeMutation } from "./watcher-tree-reconciliation"
import { registerEditorSerialization } from "./tiptap/editor-serialization-lifecycle"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

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
    const refreshTreePaths = vi.fn().mockResolvedValue([])
    const applyMutationResult = vi.fn()
    const hook = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: false,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [],
        refreshTreePaths,
        applyMutationResult,
      }),
    )
    return { ...hook, refreshTreePaths, applyMutationResult }
  }

  it("switches repeatedly to cached sketch and canvas layers without rebuilding the tree", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, layers)
    const { result, refreshTreePaths, applyMutationResult } = setup()
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
      expect(refreshTreePaths).not.toHaveBeenCalled()
      expect(applyMutationResult).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it("reads unknown layer presence and opens an existing sketch without a mutation", async () => {
    // The initial layer lookup is still pending when the user switches.
    vi.mocked(storage.noteLayers).mockImplementationOnce(() => new Promise(() => {}))
    const { result, refreshTreePaths } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("sketch")
    expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]).toEqual(layers)
    expect(storage.createLayer).not.toHaveBeenCalled()
    expect(refreshTreePaths).not.toHaveBeenCalled()
  })

  it("creates a missing sketch and refreshes the tree before activating it", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, sketch: false })
    const { result, refreshTreePaths, applyMutationResult } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(storage.createLayer).toHaveBeenCalledWith(doc.path, "sketch")
    expect(refreshTreePaths).toHaveBeenCalledTimes(1)
    expect(refreshTreePaths).toHaveBeenCalledWith([doc.path, "/vault/Note/Note.excalidraw"])
    expect(applyMutationResult).toHaveBeenCalledTimes(1)
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("sketch")
    expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]?.sketch).toBe(true)
  })

  it("keeps the current layer when creation fails", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, sketch: false })
    useViewStateStore.getState().setActiveLayer(doc.id, "editor")
    vi.mocked(storage.createLayer).mockRejectedValue(new Error("write failed"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, refreshTreePaths, applyMutationResult } = setup()
    await act(() => result.current.handleLayerChange("sketch"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("editor")
    expect(refreshTreePaths).not.toHaveBeenCalled()
    expect(applyMutationResult).not.toHaveBeenCalled()
  })
})

describe("note layer loading", () => {
  it("retries a note layer load that a dependency change dropped", async () => {
    const container: Document = {
      id: "db-id",
      title: "Tasks",
      path: "/vault/Tasks/Tasks.db",
      content: "",
      source: "",
      created: "",
      modified: "",
      wordCount: 0,
    }
    useDocStore.getState().setDoc(container.id, container)
    useViewStateStore.setState({
      activeLayers: { [container.id]: "editor" },
      linkedLayersByDoc: {
        [container.id]: { note: true, sketch: false, canvas: false, database: true },
      },
    })
    const calls: Array<(raw: string) => void> = []
    vi.spyOn(storage, "readFile").mockImplementation(
      () => new Promise<string>((resolve) => calls.push(resolve)),
    )
    renderHook(() =>
      useLayers({
        vault: null,
        databasesEnabled: true,
        backendGeneration: 1,
        currentDoc: container,
        treeItems: [],
        refreshTreePaths: vi.fn().mockResolvedValue([]),
        applyMutationResult: vi.fn(),
      }),
    )
    expect(calls).toHaveLength(1)

    // Another presence update arrives while the first read is still pending.
    act(() => {
      useViewStateStore.getState().setLinkedLayers("other", {
        note: false,
        sketch: false,
        canvas: false,
        database: false,
      })
    })
    expect(calls).toHaveLength(2)

    await act(async () => {
      calls[1]("# Attached note")
    })
    expect(useDocStore.getState().openDocs[container.id]?.content).toBe("# Attached note")
  })
})

describe("deleting a layer asks in the application", () => {
  const doc: Document = {
    id: "note-id",
    title: "План",
    path: "/vault/План/План.md",
    content: "",
    source: "",
    created: "",
    modified: "",
    wordCount: 0,
  }
  const layers = { note: true, sketch: false, canvas: true, database: false }

  function setup() {
    useViewStateStore.setState({ activeLayers: {}, linkedLayersByDoc: {} })
    vi.spyOn(storage, "noteLayers").mockResolvedValue(layers)
    vi.spyOn(storage, "deleteLayer").mockResolvedValue({
      primaryPath: doc.path,
      pathChanges: [],
      deletedPaths: [],
    } as never)
    return renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: false,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [],
        refreshTreePaths: vi.fn().mockResolvedValue([]),
        applyMutationResult: vi.fn().mockReturnValue(true),
      }),
    )
  }

  it("is a dangerous question that names the note; Cancel deletes nothing", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { result } = setup()
    await act(() => result.current.handleDeleteLayer("canvas"))
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.destructive).toBe(true)
    expect(question.title).toContain("План")
    expect(storage.deleteLayer).not.toHaveBeenCalled()
  })

  it("deletes the layer after yes", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const { result } = setup()
    await act(() => result.current.handleDeleteLayer("canvas"))
    expect(storage.deleteLayer).toHaveBeenCalledWith("/vault", doc.path, "canvas")
  })
})

describe("remote database attachment", () => {
  const doc: Document = {
    id: "remote-note",
    noteId: "remote-note",
    title: "Remote",
    path: "/vault/Remote.md",
    content: "text",
    source: "text",
    created: "",
    modified: "",
    wordCount: 1,
  }
  const plain = { note: true, canvas: false, sketch: false, database: false }

  beforeEach(() => {
    useViewStateStore.setState({ activeLayers: {}, linkedLayersByDoc: { [doc.id]: plain } })
    useDatabaseStore.getState().reset(null)
    vi.spyOn(storage, "noteLayers").mockResolvedValue(plain)
    vi.spyOn(storage, "createDatabase")
  })

  function setup() {
    return renderHook(
      ({ currentDoc }) =>
        useLayers({
          vault: "/vault",
          databasesEnabled: true,
          backendGeneration: 1,
          currentDoc,
          treeItems: [],
          refreshTreePaths: vi.fn().mockResolvedValue([]),
          applyMutationResult: vi.fn(),
        }),
      { initialProps: { currentDoc: doc } },
    )
  }

  it("detects a manifest arriving after the note was moved without recreating the database", async () => {
    const { result, rerender } = setup()
    const moved = { ...doc, path: "/vault/Remote/Remote.md" }
    rerender({ currentDoc: moved })
    await waitFor(() => expect(storage.noteLayers).toHaveBeenCalledWith(moved.path))
    vi.mocked(storage.noteLayers).mockResolvedValue({ ...plain, database: true })
    act(() => useDatabaseStore.getState().invalidateHosts())
    await waitFor(() =>
      expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]?.database).toBe(true),
    )
    useDatabaseStore.setState({
      databases: [{ databaseId: "db", attachedNoteId: doc.id }] as never,
    })
    await act(() => result.current.handleLayerChange("database"))
    expect(storage.createDatabase).not.toHaveBeenCalled()
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("database")
  })

  it("creates the database immediately on attachment and holds watcher refreshes until the tree is updated", async () => {
    let publish: (value: Awaited<ReturnType<typeof storage.createDatabase>>) => void = () => {}
    vi.mocked(storage.createDatabase).mockImplementation(
      () =>
        new Promise((resolve) => {
          publish = resolve
        }),
    )
    const item = { id: doc.id, path: doc.path, name: doc.title, type: "file" as const }
    const refreshTreePaths = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: true,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [item],
        refreshTreePaths,
        applyMutationResult: vi.fn(),
      }),
    )
    let attached: Promise<void>
    act(() => {
      attached = result.current.handleAttachLayerToFile(doc.id, "database")
    })
    expect(storage.createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "attached", notePath: doc.path }),
    )
    expect(hasActiveLocalTreeMutation()).toBe(true)
    await act(async () => {
      publish({
        databaseId: "new-db",
        title: doc.title,
        manifestRevision: "r",
        viewId: "v",
        viewRevision: "r",
        manifestPath: "/vault/Remote/Remote.json",
        viewPath: "/vault/Remote/Remote.json",
        notePath: "/vault/Remote/Remote.md",
        warnings: [],
      })
      await attached!
    })
    expect(refreshTreePaths).toHaveBeenCalledWith([
      doc.path,
      "/vault/Remote/Remote.md",
      "/vault/Remote/Remote.json",
    ])
    expect(hasActiveLocalTreeMutation()).toBe(false)
  })

  it("does not let a delayed layer read hide the database after a newer invalidation", async () => {
    let finishOld: (value: typeof plain) => void = () => {}
    vi.mocked(storage.noteLayers)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValue({ ...plain, database: true })
    setup()
    act(() => useDatabaseStore.getState().invalidateHosts())
    await waitFor(() => expect(storage.noteLayers).toHaveBeenCalledTimes(1))
    act(() => useDatabaseStore.getState().invalidateHosts())
    await waitFor(() =>
      expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]?.database).toBe(true),
    )
    await act(async () => finishOld(plain))
    expect(useViewStateStore.getState().linkedLayersByDoc[doc.id]?.database).toBe(true)
  })
})

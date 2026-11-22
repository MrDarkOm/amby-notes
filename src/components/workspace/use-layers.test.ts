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
  // The text of a layer holds lines that look like an ID; the backend's tree is the only source.
  const source = "---\ntitle: Задачи\n---\nid: чужой\n# Tasks\n"
  const tree = [
    { id: "real-id", path: "/vault/Tasks/Tasks.md", name: "Tasks", type: "file" as const },
  ]

  beforeEach(() => {
    vi.spyOn(storage, "readFile").mockResolvedValue(source)
    vi.spyOn(storage, "readNote").mockImplementation(async (_vault, id) => {
      if (id !== "real-id") throw new Error("Note not found")
      return { content: "# Tasks\n", revision: "backend-revision", source }
    })
  })

  it("takes the ID and the revision from the backend, not from the text", async () => {
    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md", "/vault", tree)

    expect(result.noteId).toBe("real-id")
    expect(result.revision).toBe("backend-revision")
    expect(result.content).toBe("# Tasks\n")
    expect(result.readOnly).toBe(false)
    expect(storage.readNote).not.toHaveBeenCalledWith("/vault", "чужой")
  })

  it("is read only, with no ID and no revision, when the backend does not know the layer", async () => {
    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md", "/vault", [])

    expect(result.noteId).toBeUndefined()
    expect(result.revision).toBeUndefined()
    expect(result.readOnly).toBe(true)
    expect(result.source).toBe(source)
    expect(storage.readNote).not.toHaveBeenCalled()
  })

  it("is read only when the backend fails to read the note", async () => {
    vi.spyOn(storage, "readNote").mockRejectedValue(new Error("not indexed"))
    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md", "/vault", tree)

    expect(result.noteId).toBeUndefined()
    expect(result.revision).toBeUndefined()
    expect(result.readOnly).toBe(true)
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

  function setup(supernotesEnabled = true) {
    const refreshTreePaths = vi.fn().mockResolvedValue([])
    const applyMutationResult = vi.fn()
    const hook = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: false,
        supernotesEnabled,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [],
        refreshTreePaths,
        applyMutationResult,
      }),
    )
    return { ...hook, refreshTreePaths, applyMutationResult }
  }

  it("opens existing layers with Supernotes off and leaves missing layers absent", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, sketch: false })
    const { result } = setup(false)
    await act(() => result.current.handleLayerChange("canvas"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("canvas")
    await act(() => result.current.handleLayerChange("sketch"))
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("canvas")
    expect(storage.createLayer).not.toHaveBeenCalled()
  })

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

  it("makes a freshly created note layer editable at once, with the ID and revision of the backend", async () => {
    useViewStateStore.getState().setLinkedLayers(doc.id, { ...layers, note: false })
    useDocStore.getState().setDoc(doc.id, { ...doc, path: "/vault/Note/Note.canvas" })
    const source = "---\nid: чужой\n---\ntext\n"
    vi.mocked(storage.createLayer).mockResolvedValue({
      kind: "note",
      notePath: "/vault/Note/Note.canvas",
      layerPath: "/vault/Note/Note.md",
      pathChanges: [],
    })
    vi.spyOn(storage, "readFile").mockResolvedValue(source)
    const readNote = vi
      .spyOn(storage, "readNote")
      .mockResolvedValue({ content: "text\n", revision: "backend-revision", source })
    const { result, refreshTreePaths } = setup()
    refreshTreePaths.mockResolvedValue([
      { id: "new-note-id", path: "/vault/Note/Note.md", name: "Note", type: "file" },
    ])
    await act(() => result.current.handleLayerChange("editor"))
    expect(readNote).toHaveBeenCalledWith("/vault", "new-note-id")
    const stored = useDocStore.getState().openDocs[doc.id]
    expect(stored?.noteId).toBe("new-note-id")
    expect(stored?.revision).toBe("backend-revision")
    expect(stored?.noteProperties?.bodyReadOnly).not.toBe(true)
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

  it("returns to the database after deleting its text and opens the reattached note", async () => {
    const container = { ...doc, id: "database-id", path: "/vault/Plan" }
    const notePath = "/vault/Plan/Plan.md"
    const row = { id: container.id, path: container.path, name: "Plan", type: "database" as const }
    const remaining = { note: false, sketch: false, canvas: false, database: true }
    const linked = { ...remaining, note: true }
    useDocStore.getState().setDoc(container.id, container)
    useViewStateStore.setState({
      activeLayers: { [container.id]: "editor" },
      linkedLayersByDoc: { [container.id]: linked },
    })
    vi.mocked(confirm).mockResolvedValue(true)
    vi.spyOn(storage, "noteLayers").mockResolvedValue(remaining)
    vi.spyOn(storage, "deleteLayer").mockResolvedValue({
      primaryId: null,
      primaryPath: container.path,
      pathChanges: [],
      deletedPaths: [notePath],
      deletedIds: [],
    })
    vi.spyOn(storage, "readFile").mockResolvedValue("")
    vi.spyOn(storage, "readNote").mockResolvedValue({
      content: "",
      source: "",
      revision: "new-revision",
    })
    const create = vi.spyOn(storage, "createLayer").mockResolvedValue({
      notePath: container.path,
      layerPath: notePath,
      kind: "note",
      pathChanges: [],
    })
    const { result } = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: true,
        backendGeneration: 1,
        currentDoc: container,
        treeItems: [row],
        refreshTreePaths: vi.fn().mockResolvedValue([
          {
            ...row,
            bundleMembers: [{ id: "replacement", path: notePath, name: "Plan", type: "file" }],
          },
        ]),
        applyMutationResult: vi.fn().mockReturnValue(true),
      }),
    )

    await act(() => result.current.handleDeleteLayer("note"))
    expect(useViewStateStore.getState().activeLayers[container.id]).toBe("database")
    expect(useViewStateStore.getState().linkedLayersByDoc[container.id]).toEqual(remaining)

    vi.mocked(storage.noteLayers).mockResolvedValue(linked)
    await act(() => result.current.handleAttachLayerToFile(container.id, "note"))
    expect(create).toHaveBeenCalledWith(container.path, "note")
    expect(useViewStateStore.getState().activeLayers[container.id]).toBe("editor")
    expect(useDocStore.getState().openDocs[container.id]).toMatchObject({
      noteId: "replacement",
      revision: "new-revision",
    })
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
    let finishCatalog: () => void = () => {}
    const refreshDatabaseCatalog = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCatalog = resolve
        }),
    )
    const { result } = renderHook(() =>
      useLayers({
        vault: "/vault",
        databasesEnabled: true,
        backendGeneration: 1,
        currentDoc: doc,
        treeItems: [item],
        refreshTreePaths,
        refreshDatabaseCatalog,
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
    })
    await waitFor(() => expect(refreshDatabaseCatalog).toHaveBeenCalled())
    expect(useViewStateStore.getState().activeLayers[doc.id]).toBe("database")
    await act(async () => {
      finishCatalog()
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

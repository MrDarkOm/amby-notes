// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { serializeCanvas } from "@/lib/canvas-format"
import * as storage from "@/lib/storage"
import { StorageOperationError } from "@/lib/storage/operation-error"
import { useDocStore } from "../use-doc-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useCanvasWorkspace } from "./use-canvas-workspace"

describe("useCanvasWorkspace", () => {
  it("does not schedule autosave when saving identical canvas content", async () => {
    const t = ((k: string) => k) as never
    const recoveryScope = { vault: "/vault", generation: 1 }

    const { result } = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    const canvasPath = "/vault/test.canvas"
    const canvasJson = serializeCanvas({ nodes: [], edges: [] })

    // First save registers the canvas and schedules
    act(() => {
      result.current.handleCanvasSave(canvasPath, canvasJson)
    })

    const initialPending = result.current.autosave.inspect(result.current.autosaveKey(canvasPath))
    expect(initialPending?.dirty).toBe(true)

    // Flush or clear dirty
    await act(async () => {
      await result.current.autosave.flushAll()
    })
    const flushedPending = result.current.autosave.inspect(result.current.autosaveKey(canvasPath))
    expect(flushedPending?.dirty).toBe(false)

    // Second save with identical content must be a no-op
    act(() => {
      result.current.handleCanvasSave(canvasPath, canvasJson)
    })

    const afterNoopPending = result.current.autosave.inspect(result.current.autosaveKey(canvasPath))
    expect(afterNoopPending?.dirty).toBe(false)
  })
})

const sampleJson = (n: number) =>
  serializeCanvas({
    nodes: n ? [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "x" }] : [],
    edges: [],
  } as never)

describe("useCanvasWorkspace: a canvas deleted by Amby", () => {
  const t = ((k: string) => k) as never
  const recoveryScope = { vault: "/vault", generation: 1 }
  const path = "/vault/gone.canvas"
  const save = (r: { current: ReturnType<typeof useCanvasWorkspace> }, json: string) =>
    r.current.handleCanvasSave(path, json)

  it("drops a save the closing editor sends after the delete (no question, no file)", async () => {
    const { result } = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    act(() => save(result, sampleJson(0)))
    await act(async () => {
      await result.current.autosave.flushAll()
    })

    act(() => result.current.discardDeleted([path]))
    act(() => save(result, sampleJson(1)))

    const pending = result.current.autosave.inspect(result.current.autosaveKey(path))
    expect(pending?.dirty ?? false).toBe(false)
  })

  it("drops a save for a file inside a deleted folder", () => {
    const { result } = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    act(() => save(result, sampleJson(0)))
    act(() => result.current.discardDeleted(["/vault"]))
    act(() => save(result, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
  })

  it("forgets the file's baseline and its queued save", () => {
    const { result } = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    act(() => save(result, sampleJson(0)))
    const forget = vi.spyOn(result.current.fileRevisions, "forget")
    act(() => result.current.discardDeleted([path]))
    expect(forget).toHaveBeenCalledWith(path)
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
  })

  it("saves again once the same path is opened again (restored from the trash)", async () => {
    const { result } = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    act(() => result.current.discardDeleted([path]))
    await act(async () => {
      await result.current.loadCanvasBuffer(path)
    })
    act(() => save(result, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty).toBe(true)
  })
})

// SAVE-01: a canvas that cannot be read must never become an empty editable board whose first edit
// overwrites the file. SAVE-05: a failed canvas save is shown on the note, like a failed note save.
describe("useCanvasWorkspace: unreadable files and failed saves", () => {
  const t = ((k: string) => k) as never
  const recoveryScope = { vault: "/vault-unreadable", generation: 1 }
  // A path per case: a draft queued by one case must not be offered to the next.
  let caseNumber = 0
  let path = ""

  afterEach(() => {
    vi.restoreAllMocks()
    useDocStore.setState({ openDocs: {}, unsavedFileIds: new Set(), externalConflicts: {} })
    useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  })

  function setup() {
    caseNumber += 1
    path = `/vault-unreadable/Board-${caseNumber}.canvas`
    const hook = renderHook(() => useCanvasWorkspace(1, t, recoveryScope))
    vi.spyOn(hook.result.current.fileRevisions, "baseline").mockResolvedValue()
    return hook
  }

  it("refuses to open a canvas whose content cannot be read, and never saves over it", async () => {
    vi.spyOn(storage, "readFile").mockResolvedValue("{ not json")
    const { result } = setup()
    await expect(result.current.loadCanvasBuffer(path)).rejects.toThrow()
    act(() => result.current.handleCanvasSave(path, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
  })

  it("opens a missing canvas as an empty board that can be saved", async () => {
    vi.spyOn(storage, "readFile").mockRejectedValue(
      new StorageOperationError("notFound", "No such file or directory (os error 2)"),
    )
    const { result } = setup()
    await expect(result.current.loadCanvasBuffer(path)).resolves.toBe(
      serializeCanvas({ nodes: [], edges: [] }),
    )
    act(() => result.current.handleCanvasSave(path, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty).toBe(true)
  })

  it("opens a canvas with a BOM and without edges with its nodes", async () => {
    vi.spyOn(storage, "readFile").mockResolvedValue(
      '\uFEFF{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1,"text":"x"}]}',
    )
    const { result } = setup()
    const content = await result.current.loadCanvasBuffer(path)
    expect(JSON.parse(content).nodes).toHaveLength(1)
  })

  it("marks the note unsaved while its canvas waits, and shows a failed save on the note", async () => {
    vi.spyOn(storage, "writeFile").mockRejectedValue(new Error("disk full"))
    const { result } = setup()
    useDocStore.getState().setDoc("board", {
      id: "board",
      title: "Board",
      path,
      content: "",
      source: "",
      revision: "",
      created: "",
      modified: "",
      wordCount: 0,
    })
    act(() => result.current.handleCanvasSave(path, sampleJson(1)))
    expect(useDocStore.getState().unsavedFileIds.has("board")).toBe(true)
    await act(async () => {
      await result.current.autosave.flushAll().catch(() => {
        // The failure itself is what is checked below.
      })
    })
    expect(useNoteNoticesStore.getState().saveFailed.board).toBe(true)
    expect(useDocStore.getState().unsavedFileIds.has("board")).toBe(true)
  })
})

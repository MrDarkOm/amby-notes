// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultSketchJson } from "@/lib/sketch-format"
import * as storage from "@/lib/storage"
import { StorageOperationError } from "@/lib/storage/operation-error"
import { useDocStore } from "../use-doc-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useSketchWorkspace } from "./use-sketch-workspace"

describe("useSketchWorkspace", () => {
  it("does not schedule autosave when saving identical sketch content", async () => {
    const t = ((k: string) => k) as never
    const recoveryScope = { vault: "/vault", generation: 1 }

    const { result } = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
    const sketchPath = "/vault/test.excalidraw"
    const sketchJson = defaultSketchJson()

    // First save registers the sketch and schedules
    act(() => {
      result.current.handleSketchSave(sketchPath, sketchJson)
    })

    const initialPending = result.current.autosave.inspect(result.current.autosaveKey(sketchPath))
    expect(initialPending?.dirty).toBe(true)

    // Flush or clear dirty
    await act(async () => {
      await result.current.autosave.flushAll()
    })
    const flushedPending = result.current.autosave.inspect(result.current.autosaveKey(sketchPath))
    expect(flushedPending?.dirty).toBe(false)

    // Second save with identical content must be a no-op
    act(() => {
      result.current.handleSketchSave(sketchPath, sketchJson)
    })

    const afterNoopPending = result.current.autosave.inspect(result.current.autosaveKey(sketchPath))
    expect(afterNoopPending?.dirty).toBe(false)
  })
})

const sampleJson = (n: number) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [],
    appState: { viewBackgroundColor: n ? "#ffeeee" : "#ffffff" },
    files: {},
  })

describe("useSketchWorkspace: a sketch deleted by Amby", () => {
  const t = ((k: string) => k) as never
  const recoveryScope = { vault: "/vault", generation: 1 }
  const path = "/vault/gone.excalidraw"
  const save = (r: { current: ReturnType<typeof useSketchWorkspace> }, json: string) =>
    r.current.handleSketchSave(path, json)

  it("drops a save the closing editor sends after the delete (no question, no file)", async () => {
    const { result } = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
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
    const { result } = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
    act(() => save(result, sampleJson(0)))
    act(() => result.current.discardDeleted(["/vault"]))
    act(() => save(result, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
  })

  it("forgets the file's baseline and its queued save", () => {
    const { result } = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
    act(() => save(result, sampleJson(0)))
    const forget = vi.spyOn(result.current.fileRevisions, "forget")
    act(() => result.current.discardDeleted([path]))
    expect(forget).toHaveBeenCalledWith(path)
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
  })

  it("saves again once the same path is opened again (restored from the trash)", async () => {
    const { result } = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
    act(() => result.current.discardDeleted([path]))
    await act(async () => {
      await result.current.loadSketchBuffer(path)
    })
    act(() => save(result, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty).toBe(true)
  })
})

// SAVE-01: a sketch that cannot be read is not opened as an empty drawing, and nothing is saved over it.
describe("useSketchWorkspace: an unreadable sketch", () => {
  it("refuses to open it and never saves over it", async () => {
    const t = ((k: string) => k) as never
    const path = "/vault-unreadable/Broken.excalidraw"
    vi.spyOn(storage, "readFile").mockResolvedValue("{ not json")
    const { result } = renderHook(() =>
      useSketchWorkspace(1, t, { vault: "/vault-unreadable", generation: 1 }),
    )
    vi.spyOn(result.current.fileRevisions, "baseline").mockResolvedValue()
    await expect(result.current.loadSketchBuffer(path)).rejects.toThrow()
    act(() => result.current.handleSketchSave(path, defaultSketchJson()))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty ?? false).toBe(
      false,
    )
    vi.restoreAllMocks()
  })
})

// SAVE-12: the sketch hook shares its body with the canvas hook; these pin the paths the canvas tests
// cover so a shared implementation cannot drift for sketches.
describe("useSketchWorkspace: missing files and failed saves", () => {
  const t = ((k: string) => k) as never
  const recoveryScope = { vault: "/vault-missing", generation: 1 }
  let caseNumber = 0
  let path = ""

  afterEach(() => {
    vi.restoreAllMocks()
    useDocStore.setState({ openDocs: {}, unsavedFileIds: new Set(), externalConflicts: {} })
    useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  })

  function setup() {
    caseNumber += 1
    path = `/vault-missing/Sketch-${caseNumber}.excalidraw`
    const hook = renderHook(() => useSketchWorkspace(1, t, recoveryScope))
    vi.spyOn(hook.result.current.fileRevisions, "baseline").mockResolvedValue()
    return hook
  }

  it("opens a missing sketch as an empty drawing that can be saved", async () => {
    vi.spyOn(storage, "readFile").mockRejectedValue(
      new StorageOperationError("notFound", "No such file or directory (os error 2)"),
    )
    const { result } = setup()
    await expect(result.current.loadSketchBuffer(path)).resolves.toBe(defaultSketchJson())
    act(() => result.current.handleSketchSave(path, sampleJson(1)))
    expect(result.current.autosave.inspect(result.current.autosaveKey(path))?.dirty).toBe(true)
  })

  it("marks the note unsaved while its sketch waits, and shows a failed save on the note", async () => {
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
    act(() => result.current.handleSketchSave(path, sampleJson(1)))
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

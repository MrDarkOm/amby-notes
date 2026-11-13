// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { defaultSketchJson } from "@/lib/sketch-format"
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

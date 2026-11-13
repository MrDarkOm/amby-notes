// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { serializeCanvas } from "@/lib/canvas-format"
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

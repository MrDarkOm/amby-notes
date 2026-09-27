// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
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

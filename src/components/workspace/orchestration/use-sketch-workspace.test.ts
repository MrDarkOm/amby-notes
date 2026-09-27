// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
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

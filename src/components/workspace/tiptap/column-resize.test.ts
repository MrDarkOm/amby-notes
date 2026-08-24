import { describe, expect, it } from "vitest"

import { createResizeSessionCleanup } from "./column-resize"

describe("column resize cleanup", () => {
  it("runs global listener and visual cleanup only once when destroy races mouseup", () => {
    let calls = 0
    const cleanup = createResizeSessionCleanup(() => {
      calls += 1
    })

    cleanup()
    cleanup()

    expect(calls).toBe(1)
  })
})

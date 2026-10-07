import { describe, expect, it } from "vitest"
import { dragShift, dragTarget } from "./row-drag-layout"

describe("dragTarget", () => {
  const ids = ["a", "b", "c", "d"]

  it("names the row under the pointer and which side the lifted row lands on", () => {
    expect(dragTarget(ids, "b", 3)).toEqual({ overId: "d", placement: "after" })
    expect(dragTarget(ids, "c", 0)).toEqual({ overId: "a", placement: "before" })
  })

  it("keeps the pointer inside the list", () => {
    expect(dragTarget(ids, "b", -5)).toEqual({ overId: "a", placement: "before" })
    expect(dragTarget(ids, "b", 99)).toEqual({ overId: "d", placement: "after" })
    expect(dragTarget([], "b", 1)).toBeNull()
  })
})

describe("dragShift", () => {
  const base = { count: 5, step: 40 }

  it("moves the lifted row with the pointer but not out of the list", () => {
    expect(dragShift({ ...base, index: 1, from: 1, to: 1, pointerDelta: 25 })).toBe(25)
    expect(dragShift({ ...base, index: 1, from: 1, to: 0, pointerDelta: -500 })).toBe(-40)
    expect(dragShift({ ...base, index: 1, from: 1, to: 4, pointerDelta: 500 })).toBe(120)
  })

  it("slides the rows it passes out of the way, and leaves the rest", () => {
    // Lifted row 1 over row 3: rows 2 and 3 move up.
    const down = [0, 1, 2, 3, 4].map((index) =>
      dragShift({ ...base, index, from: 1, to: 3, pointerDelta: 0 }),
    )
    expect(down).toEqual([0, 0, -40, -40, 0])
    // Lifted row 3 over row 1: rows 1 and 2 move down.
    const up = [0, 1, 2, 3, 4].map((index) =>
      dragShift({ ...base, index, from: 3, to: 1, pointerDelta: 0 }),
    )
    expect(up).toEqual([0, 40, 40, 0, 0])
  })
})

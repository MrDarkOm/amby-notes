import { describe, expect, it } from "vitest"
import { movePropertyId } from "./property-order"

describe("movePropertyId", () => {
  it("moves a property before and after another property without losing IDs", () => {
    expect(movePropertyId(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"])
    expect(movePropertyId(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"])
  })

  it("keeps the same reference for invalid or no-op moves", () => {
    const ids = ["a", "b"]
    expect(movePropertyId(ids, "a", "a", "before")).toBe(ids)
    expect(movePropertyId(ids, "missing", "b", "after")).toBe(ids)
  })
})

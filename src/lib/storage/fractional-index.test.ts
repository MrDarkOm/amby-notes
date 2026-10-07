import { describe, it, expect } from "vitest"
import { generateFractionalIndex, getInitialOrderKey, compareOrderKeys } from "./fractional-index"

describe("fractional-index", () => {
  it("generates initial order key", () => {
    const key = getInitialOrderKey()
    expect(key).toBe("a0")
  })

  it("generates key between null and null", () => {
    const key = generateFractionalIndex(null, null)
    expect(key).toBe("a0")
  })

  it("generates key before after-only key", () => {
    const after = "a0"
    const key = generateFractionalIndex(null, after)
    expect(compareOrderKeys(key, after)).toBe(-1)
    expect(key < after).toBe(true)
  })

  it("generates key after before-only key", () => {
    const before = "a0"
    const key = generateFractionalIndex(before, null)
    expect(compareOrderKeys(before, key)).toBe(-1)
    expect(before < key).toBe(true)
  })

  it("generates key strictly between two keys", () => {
    const k1 = "a0"
    const k2 = "b0"
    const mid = generateFractionalIndex(k1, k2)
    expect(k1 < mid).toBe(true)
    expect(mid < k2).toBe(true)
  })

  it("supports repeated insertions between two consecutive keys", () => {
    let prev = "a0"
    const next = "a1"
    for (let i = 0; i < 10; i++) {
      const inserted = generateFractionalIndex(prev, next)
      expect(prev < inserted).toBe(true)
      expect(inserted < next).toBe(true)
      prev = inserted
    }
  })

  it("supports repeated prepends", () => {
    let current = "a0"
    for (let i = 0; i < 10; i++) {
      const prepended = generateFractionalIndex(null, current)
      expect(prepended < current).toBe(true)
      current = prepended
    }
  })

  it("supports repeated appends", () => {
    let current = "a0"
    for (let i = 0; i < 10; i++) {
      const appended = generateFractionalIndex(current, null)
      expect(current < appended).toBe(true)
      current = appended
    }
  })
})

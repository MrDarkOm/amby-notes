import { describe, expect, it } from "vitest"

import { isRichIconValue, makeIconValue, parseIconValue } from "./icon-values"

describe("icon values", () => {
  it("round-trips a colored icon", () => {
    const value = makeIconValue("star", "#a855f7")
    const parsed = parseIconValue(value)
    expect(parsed?.name).toBe("star")
    expect(parsed?.color).toBe("#a855f7")
    expect(isRichIconValue(value)).toBe(true)
  })

  it("accepts cropped raster images but rejects SVG data", () => {
    expect(isRichIconValue("data:image/webp;base64,AAAA")).toBe(true)
    expect(isRichIconValue("data:image/svg+xml;base64,AAAA")).toBe(false)
  })
})

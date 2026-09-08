import { describe, expect, it } from "vitest"
import { calculateDownloadPercent } from "./app-updater"

describe("app updater progress", () => {
  it("reports a bounded whole-number percentage", () => {
    expect(calculateDownloadPercent(0, 200)).toBe(0)
    expect(calculateDownloadPercent(51, 200)).toBe(26)
    expect(calculateDownloadPercent(250, 200)).toBe(100)
    expect(calculateDownloadPercent(-10, 200)).toBe(0)
  })

  it("keeps progress indeterminate when the server omits the content length", () => {
    expect(calculateDownloadPercent(50)).toBeNull()
    expect(calculateDownloadPercent(50, 0)).toBeNull()
  })
})

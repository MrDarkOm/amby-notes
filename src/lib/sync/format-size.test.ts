import { describe, expect, it } from "vitest"
import { formatSize } from "./format-size"

describe("formatSize (decimal, like Finder: appendix Е, У2)", () => {
  it("writes the sizes of the plans of the owner the way the person reads them", () => {
    expect(formatSize(20_000_000, "ru")).toBe("20 МБ")
    expect(formatSize(1_000_000_000, "ru")).toBe("1 ГБ")
    expect(formatSize(10_000_000_000, "ru")).toBe("10 ГБ")
    expect(formatSize(200_000_000, "ru")).toBe("200 МБ")
    expect(formatSize(312_000_000, "ru")).toBe("312 МБ")
  })

  it("never uses binary units", () => {
    expect(formatSize(1_048_576, "ru")).toBe("1 МБ")
    expect(formatSize(1_024, "ru")).toBe("1 КБ")
    expect(formatSize(999_999_999, "ru")).toBe("1 ГБ")
  })

  it("has one decimal under ten of a unit and none above", () => {
    expect(formatSize(1_500_000, "ru")).toBe("1,5 МБ")
    expect(formatSize(1_500_000, "en")).toBe("1.5 MB")
    expect(formatSize(12_345_678, "ru")).toBe("12 МБ")
    expect(formatSize(9_950_000, "en")).toBe("10 MB")
  })

  it("writes small sizes in bytes and knows zero", () => {
    expect(formatSize(0, "ru")).toBe("0 Б")
    expect(formatSize(950, "ru")).toBe("950 Б")
    expect(formatSize(950, "en")).toBe("950 B")
  })

  it("goes up to terabytes", () => {
    expect(formatSize(2_500_000_000_000, "en")).toBe("2.5 TB")
  })
})

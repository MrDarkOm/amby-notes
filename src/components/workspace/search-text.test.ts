import { describe, expect, it } from "vitest"
import { caseInsensitiveRange } from "./search-text"

describe("caseInsensitiveRange", () => {
  it("returns original boundaries for Cyrillic, emoji, combining marks, and Turkish I", () => {
    const text = "Начало 🚀 İstanbul éclair"

    expect(caseInsensitiveRange(text, "НАЧ")).toEqual([0, 3])
    expect(caseInsensitiveRange(text, "🚀")).toEqual([7, 9])
    expect(caseInsensitiveRange(text, "İST")).toEqual([10, 13])
    expect(caseInsensitiveRange(text, "ÉC")).toEqual([19, 22])
  })
})

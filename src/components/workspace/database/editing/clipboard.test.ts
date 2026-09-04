import { describe, expect, it } from "vitest"
import { parseTsvRectangle, preflightTsvPaste } from "./clipboard"

describe("database clipboard", () => {
  it("parses a rectangular TSV payload and removes a terminal newline", () => {
    expect(parseTsvRectangle("a\tb\r\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
  })

  it("blocks the entire paste when one typed cell is invalid", () => {
    const result = preflightTsvPaste("1\tbad", [
      {
        propertyId: "number",
        parse: (value) =>
          /^\d+$/u.test(value) ? JSON.stringify({ type: "number", decimal: value }) : null,
      },
      {
        propertyId: "number-2",
        parse: (value) =>
          /^\d+$/u.test(value) ? JSON.stringify({ type: "number", decimal: value }) : null,
      },
    ])
    expect(result.cells).toEqual([])
    expect(result.errors).toHaveLength(1)
  })
})

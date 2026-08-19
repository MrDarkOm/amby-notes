import { describe, expect, it } from "vitest"
import { validateAndSerializeCanvas } from "./canvas-format"

describe("validateAndSerializeCanvas", () => {
  it("normalizes a valid Canvas document before persistence", () => {
    expect(validateAndSerializeCanvas('{"edges":[],"nodes":[],"pluginData":{"x":1}}')).toBe(
      '{\n  "nodes": [],\n  "edges": [],\n  "pluginData": {\n    "x": 1\n  }\n}\n',
    )
  })

  it("rejects malformed or incomplete Canvas JSON", () => {
    expect(() => validateAndSerializeCanvas("not json")).toThrow("valid JSON")
    expect(() => validateAndSerializeCanvas('{"nodes":[]}')).toThrow("nodes and edges")
  })
})

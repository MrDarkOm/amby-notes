import { describe, expect, it } from "vitest"
import { schemaExtensions } from "./schema"

describe("editor schema", () => {
  it("does not offer table column resizing: a Markdown table cannot keep a width", () => {
    const table = schemaExtensions.find((extension) => extension.name === "table")
    expect(table).toBeDefined()
    expect((table?.options as { resizable?: boolean }).resizable).toBe(false)
  })
})

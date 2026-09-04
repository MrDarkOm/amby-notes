import { describe, expect, it } from "vitest"
import { parseDatabaseLinkedReference, serializeDatabaseLinkedReference } from "./linked-reference"

const databaseId = "01J00000000000000000000000"
const viewId = "01J00000000000000000000001"

describe("database linked references", () => {
  it("accepts portable references and preserves raw fence content", () => {
    const raw = ` {\n  "databaseId": "${databaseId}",\n  "viewId": "${viewId}"\n} `
    const parsed = parseDatabaseLinkedReference(raw)
    expect(parsed?.value).toEqual({ databaseId, viewId })
    expect(parsed && serializeDatabaseLinkedReference(parsed)).toBe(raw)
  })

  it("rejects legacy IDs, invalid IDs, and external layouts", () => {
    expect(parseDatabaseLinkedReference("legacy-block-id")).toBeNull()
    expect(parseDatabaseLinkedReference(JSON.stringify({ databaseId, viewId: "bad" }))).toBeNull()
    expect(
      parseDatabaseLinkedReference(JSON.stringify({ databaseId, viewId, layout: 3 })),
    ).toBeNull()
  })

  it("creates a changed reference only when explicitly requested", () => {
    const parsed = parseDatabaseLinkedReference(JSON.stringify({ databaseId, viewId }))!
    const changed = serializeDatabaseLinkedReference(parsed, { layout: "list" })
    expect(JSON.parse(changed)).toMatchObject({ databaseId, viewId, layout: "list" })
  })
})

import { describe, expect, it } from "vitest"
import {
  databaseCellText,
  encodeDatabaseCellDraft,
  readDatabaseCellValue,
} from "./database-cell-value"

describe("database cell values", () => {
  it("reads typed values without exposing malformed row JSON", () => {
    expect(
      readDatabaseCellValue('{"property":{"type":"text","value":"hello"}}', "property"),
    ).toEqual({ type: "text", value: "hello" })
    expect(readDatabaseCellValue("not json", "property")).toBeNull()
  })

  it("encodes supported drafts with the durable PropertyValue shape", () => {
    expect(encodeDatabaseCellDraft("text", "hello")).toBe('{"type":"text","value":"hello"}')
    expect(encodeDatabaseCellDraft("number", "12.50")).toBe('{"type":"number","decimal":"12.50"}')
    expect(encodeDatabaseCellDraft("date", "2026-09-04")).toBe(
      '{"type":"date","start":"2026-09-04","end":null,"timeZone":null}',
    )
    expect(encodeDatabaseCellDraft("url", "https://example.com")).toBe(
      '{"type":"url","value":"https://example.com"}',
    )
    expect(encodeDatabaseCellDraft("text", "")).toBeUndefined()
  })

  it("projects typed stored values into editable text", () => {
    expect(databaseCellText({ type: "number", decimal: "9007199254740993" }, "number")).toBe(
      "9007199254740993",
    )
    expect(databaseCellText({ type: "date", start: "2026-09-04" }, "date")).toBe("2026-09-04")
  })
})

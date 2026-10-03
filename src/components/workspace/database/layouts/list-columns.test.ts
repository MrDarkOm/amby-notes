import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { listColumns } from "./list-columns"

const property = (id: string, type = "text"): DatabasePropertySummary => ({
  propertyId: id,
  name: id,
  propertyType: type,
  configJson: "{}",
  options: [],
})
const properties = [property("a"), property("b"), property("c"), property("d"), property("e")]
const row = (values: Record<string, unknown>): DatabaseRow => ({
  noteId: "n",
  title: "T",
  relativePath: "T.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(values),
  rowRevision: "r",
})
const text = (value: string) => ({ type: "text", value })

describe("listColumns", () => {
  it("uses the properties chosen in the view, in that order", () => {
    expect(listColumns([row({ a: text("x") })], properties, ["c", "a"])).toEqual(["c", "a"])
    expect(listColumns([], properties, [])).toEqual([])
  })

  it("takes the first three properties that have a value in any row, in schema order", () => {
    const rows = [row({ d: text("x"), b: text("y") }), row({ e: text("z"), a: text("w") })]
    expect(listColumns(rows, properties, null)).toEqual(["a", "b", "d"])
  })

  it("is the same for every row, so the columns line up", () => {
    const rows = [row({ a: text("x") }), row({ b: text("y") }), row({})]
    expect(listColumns(rows, properties, null)).toEqual(["a", "b"])
  })

  it("has no columns when nothing has a value", () => {
    expect(listColumns([row({})], properties, null)).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { parseCsv, planCsvCreates, serializeCsv } from "./csv"

describe("database CSV", () => {
  it("round-trips quoted commas, quotes, and newlines", () => {
    const source = serializeCsv([
      ["Title", "Text"],
      ["One, two", 'say "hi"\nnow'],
    ])
    expect(parseCsv(source)).toEqual([
      ["Title", "Text"],
      ["One, two", 'say "hi"\nnow'],
    ])
  })

  it("plans creates without matching existing titles", () => {
    expect(
      planCsvCreates("Title,Status\nExisting,done\nNew,todo", 0, [
        { sourceIndex: 1, propertyId: "status" },
      ]),
    ).toEqual([
      { title: "Existing", values: { status: "done" } },
      { title: "New", values: { status: "todo" } },
    ])
  })
})

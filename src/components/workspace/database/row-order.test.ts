import { describe, expect, it } from "vitest"
import type { DatabaseRow } from "@/lib/storage"
import { applyManualOrder, moveRowInOrder } from "./row-order"

function row(noteId: string): DatabaseRow {
  return {
    noteId,
    title: noteId,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: "{}",
    rowRevision: "",
  }
}

const ids = (rows: DatabaseRow[]) => rows.map((entry) => entry.noteId)

describe("applyManualOrder", () => {
  it("puts placed rows first in list order and keeps the rest as loaded", () => {
    const rows = ["a", "b", "c", "d"].map(row)
    expect(ids(applyManualOrder(rows, ["c", "a"]))).toEqual(["c", "a", "b", "d"])
  })

  it("skips listed ids that are not loaded and returns the same array when nothing moves", () => {
    const rows = ["a", "b"].map(row)
    expect(applyManualOrder(rows, ["x", "a", "b"])).toBe(rows)
    expect(applyManualOrder(rows, [])).toBe(rows)
  })
})

describe("moveRowInOrder", () => {
  const shown = ["a", "b", "c", "d"]

  it("lists every shown row when nothing was placed yet", () => {
    expect(moveRowInOrder([], shown, "d", "b", "before")).toEqual(["a", "d", "b", "c"])
    expect(moveRowInOrder([], shown, "a", "c", "after")).toEqual(["b", "c", "a", "d"])
  })

  it("keeps entries of rows that are not loaded, in their relative order", () => {
    // "z" is placed but not loaded (for example filtered out or on a later page).
    const order = ["a", "z", "b", "c", "d"]
    const next = moveRowInOrder(order, shown, "c", "a", "before")
    expect(next).toEqual(["c", "a", "z", "b", "d"])
  })

  it("moves to the end when dropped after the last row", () => {
    expect(moveRowInOrder(["a", "b", "c", "d"], shown, "a", "d", "after")).toEqual([
      "b",
      "c",
      "d",
      "a",
    ])
  })

  it("reports no change for a drop that leaves the visible order as it was", () => {
    expect(moveRowInOrder([], shown, "b", "b", "after")).toBeNull()
    expect(moveRowInOrder([], shown, "b", "c", "before")).toBeNull()
    expect(moveRowInOrder([], shown, "c", "b", "after")).toBeNull()
  })

  it("ignores rows that are not shown", () => {
    expect(moveRowInOrder([], shown, "q", "a", "before")).toBeNull()
    expect(moveRowInOrder([], shown, "a", "q", "before")).toBeNull()
  })
})

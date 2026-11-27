import { describe, expect, it } from "vitest"
import type { DatabaseRow } from "@/lib/storage"
import type { Membership } from "../workshop/workshop-model"
import { sharedInUniverse } from "./scope-model"

const row = (noteId: string): DatabaseRow => ({
  noteId,
  title: noteId,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: "{}",
  rowRevision: "r",
})

function membership(map: Record<string, string[]>): Membership {
  return { storiesOf: (noteId) => map[noteId] ?? [], universeOf: () => null }
}

describe("sharedInUniverse", () => {
  const m = membership({
    anna: ["s1", "s2"],
    boris: ["s1"],
    // A story of another universe does not count toward this one's two.
    clara: ["s1", "outside"],
    dina: ["s1", "s2", "s3"],
  })

  it("marks only rows held by at least two stories of this universe", () => {
    const result = sharedInUniverse(["anna", "boris", "clara", "dina", "nobody"].map(row), m, [
      "s1",
      "s2",
      "s3",
    ])
    expect([...result]).toEqual(["anna", "dina"])
  })

  it("is empty with one story, which can share nothing", () => {
    const result = sharedInUniverse([row("anna")], m, ["s1"])
    expect([...result]).toEqual([])
  })
})

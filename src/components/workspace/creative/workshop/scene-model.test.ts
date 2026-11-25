import { describe, expect, it } from "vitest"
import type { DatabaseRow, TextPropertyIds } from "@/lib/storage"
import { readScene } from "./scene-model"

const properties: TextPropertyIds = {
  level: null,
  parent: null,
  order: null,
  format: null,
  status: null,
  anchors: null,
  arcs: null,
  characters: "who",
  pov: "eyes",
  places: "where",
  storyTime: "when",
}

function row(noteId: string, values: Record<string, unknown>): DatabaseRow {
  return {
    noteId,
    title: noteId,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: "r",
  }
}
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

describe("readScene", () => {
  it("reads who, whose eyes, where and when of a page", () => {
    const scene = readScene(
      row("p", {
        who: rel("anna", "bob"),
        eyes: rel("anna"),
        where: rel("house"),
        when: { type: "text", value: "Утро, день 3" },
      }),
      properties,
    )
    expect(scene).toEqual({
      characters: ["anna", "bob"],
      pov: "anna",
      places: ["house"],
      storyTime: "Утро, день 3",
    })
  })

  it("gives an empty scene for a page or a text without the properties", () => {
    const empty = { characters: [], pov: null, places: [], storyTime: "" }
    expect(readScene(row("p", {}), properties)).toEqual(empty)
    expect(
      readScene(row("p", { who: rel("anna") }), {
        ...properties,
        characters: null,
        pov: null,
        places: null,
        storyTime: null,
      }),
    ).toEqual(empty)
  })
})

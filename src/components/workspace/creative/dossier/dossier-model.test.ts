import { describe, expect, it } from "vitest"
import type { NoteReference } from "@/lib/storage"
import { catalog, project, section, universeCatalog } from "../project-fixtures.test-support"
import { extractToc, splitReferences, worldSectionOf } from "./dossier-model"

describe("worldSectionOf", () => {
  it("finds the section of a world database and the project it is in", () => {
    const found = worldSectionOf(universeCatalog(), "db_characters")
    expect(found?.project.projectId).toBe("palooverse")
    expect(found?.section.role).toBe("characters")
    // A section the author named himself has a dossier too.
    expect(worldSectionOf(universeCatalog(), "db_loose")?.section.id).toBe("loose")
  })

  it("gives no dossier to the text, the notes, a missing database or a stranger", () => {
    const universe = universeCatalog()
    expect(worldSectionOf(universe, "db_text")).toBeNull()
    expect(worldSectionOf(universe, "db_notes")).toBeNull()
    expect(worldSectionOf(universe, "db_unknown")).toBeNull()
    expect(worldSectionOf(null, "db_characters")).toBeNull()
    const broken = catalog([
      project("p", { sections: [section("c", { role: "characters", state: "missing" })] }),
    ])
    expect(worldSectionOf(broken, "db_c")).toBeNull()
  })
})

describe("extractToc", () => {
  it("lists the headings in reading order with their level", () => {
    const toc = extractToc("# Алиса\n\nТекст\n\n## Основное\n\n### Детство\n\n## Биография #\n")
    expect(toc).toEqual([
      { index: 0, level: 1, title: "Алиса" },
      { index: 1, level: 2, title: "Основное" },
      { index: 2, level: 3, title: "Детство" },
      { index: 3, level: 2, title: "Биография" },
    ])
  })

  it("skips fenced code, the frontmatter and lines that only look like headings", () => {
    const markdown = [
      "---",
      "# not a heading",
      "title: x",
      "---",
      "## Real",
      "```",
      "## inside a fence",
      "```",
      "~~~md",
      "## inside a tilde fence",
      "~~~",
      "#nospace",
      "    ## indented code",
      "## Second",
    ].join("\n")
    expect(extractToc(markdown).map((entry) => entry.title)).toEqual(["Real", "Second"])
  })

  it("handles CRLF files and a byte order mark", () => {
    expect(extractToc("﻿## Один\r\n\r\n## Два\r\n").map((entry) => entry.title)).toEqual([
      "Один",
      "Два",
    ])
  })

  it("has nothing for a page without headings", () => {
    expect(extractToc("просто текст\n")).toEqual([])
    expect(extractToc("")).toEqual([])
  })
})

const reference = (over: Partial<NoteReference>): NoteReference => ({
  direction: "in",
  propertyId: "p1",
  propertyName: "Участники",
  databaseId: "db_text",
  databaseName: "Текст",
  noteId: "n1",
  title: "Глава",
  ...over,
})

describe("splitReferences", () => {
  it("puts the pages of the text that point here under 'appears in'", () => {
    const split = splitReferences(
      [reference({ noteId: "a" }), reference({ noteId: "b", databaseId: "db_other" })],
      "db_text",
    )
    expect(split.appearsIn.map((entry) => entry.noteId)).toEqual(["a"])
    expect(split.connections).toHaveLength(1)
    expect(split.connections[0].items[0].noteId).toBe("b")
  })

  it("groups the other relations by property and by direction", () => {
    const split = splitReferences(
      [
        reference({ databaseId: "db_org", propertyId: "m", propertyName: "Члены", noteId: "x" }),
        reference({ databaseId: "db_org", propertyId: "m", propertyName: "Члены", noteId: "y" }),
        reference({ direction: "out", propertyId: "m", propertyName: "Члены", noteId: "z" }),
        reference({ direction: "out", propertyId: "e", propertyName: "Враг", noteId: "w" }),
      ],
      "db_text",
    )
    expect(split.appearsIn).toEqual([])
    expect(
      split.connections.map((group) => [group.direction, group.label, group.items.length]),
    ).toEqual([
      ["in", "Члены", 2],
      ["out", "Члены", 1],
      ["out", "Враг", 1],
    ])
  })

  it("keeps a note's own links to the text as connections, since they are outgoing", () => {
    const split = splitReferences([reference({ direction: "out" })], "db_text")
    expect(split.appearsIn).toEqual([])
    expect(split.connections).toHaveLength(1)
  })

  it("has no 'appears in' when the story has no text database", () => {
    expect(splitReferences([reference({})], null).appearsIn).toEqual([])
  })
})

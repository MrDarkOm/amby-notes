import { describe, expect, it } from "vitest"
import type { DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { noteTrail, trailDatabaseIds, type NoteTrailInput } from "./note-trail"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"

const labels = { workshop: "Мастерская", standalone: "Отдельные истории", universe: "Вселенная" }

const text = (databaseId: string): ProjectTextSummary => ({
  databaseId,
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: null,
    arcs: null,
  },
  levels: [{ id: "chapter", icon: null, name: "Глава", color: null, state: "ok" }],
  formats: [],
  statusOptions: [],
})

function row(
  noteId: string,
  title: string,
  values: Record<string, unknown> = {},
  categoryPath: string[] = [],
): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath,
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

const workshop = workshopSummary("w", {
  name: "Моя мастерская",
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
    section("chars", { role: "characters", name: "Персонажи", databaseId: "db_chars" }),
    section("arcs", { role: "arcs", name: "Арки", databaseId: "db_arcs" }),
    section("notes", { role: "notes", name: "Заметки", databaseId: "db_notes" }),
    section("mine", { role: "custom", name: "Моё", databaseId: "db_mine" }),
    section("gone", { role: "custom", name: "Пропало", databaseId: "db_gone", state: "missing" }),
  ],
  stories: [
    storySummary("hills", {
      name: "Холмы",
      workshopId: "w",
      databaseId: "db_hills",
      cardNoteId: "card_hills",
      text: text("db_hills"),
    }),
    storySummary("lone", {
      name: "Одиночка",
      workshopId: "w",
      databaseId: "db_lone",
      cardNoteId: "card_lone",
      text: text("db_lone"),
    }),
  ],
})
const cat = catalog([workshop])

const ROWS: NoteTrailInput["rows"] = {
  db_stories: [row("card_hills", "Холмы", { up: rel("u1") }), row("card_lone", "Одиночка")],
  db_univ: [row("u1", "Палуверс")],
  db_hills: [
    row("book", "Книга", { lvl: { type: "select", optionId: "chapter" } }),
    row("chapter", "Глава", { par: rel("book") }),
    row("scene", "Сцена", { par: rel("chapter") }),
  ],
  db_lone: [row("page", "Страница")],
}

const trail = (databaseId: string, noteRow: ReturnType<typeof row>, rows = ROWS) =>
  noteTrail({ catalog: cat, databaseId, row: noteRow, rows, labels })
const shape = (steps: ReturnType<typeof noteTrail>) =>
  steps?.map((step) => [step.label, step.to ?? null])

describe("the logical path of a note in the workshop", () => {
  it("leads a page of a story's text through its universe and the pages above it", () => {
    expect(shape(trail("db_hills", ROWS.db_hills![2]!))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Палуверс", { kind: "page", projectId: "universe:u1" }],
      ["Холмы", { kind: "page", projectId: "hills" }],
      ["Книга", { kind: "note", noteId: "book" }],
      ["Глава", { kind: "note", noteId: "chapter" }],
      ["Сцена", null],
    ])
  })

  it("has a top page of the text come straight after the story", () => {
    expect(trail("db_hills", ROWS.db_hills![0]!)?.map((s) => s.label)).toEqual([
      "Мастерская",
      "Палуверс",
      "Холмы",
      "Книга",
    ])
  })

  it("uses the standalone stories for a story that no universe holds", () => {
    expect(shape(trail("db_lone", ROWS.db_lone![0]!))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Отдельные истории", { kind: "page", projectId: "standalone:w" }],
      ["Одиночка", { kind: "page", projectId: "lone" }],
      ["Страница", null],
    ])
  })

  it("names a universe whose card is missing by the fallback, and keeps the link", () => {
    const rows = { ...ROWS, db_univ: [] }
    expect(shape(trail("db_hills", ROWS.db_hills![0]!, rows))?.[1]).toEqual([
      "Вселенная",
      { kind: "page", projectId: "universe:u1" },
    ])
  })

  it("ends a story's own card at the story", () => {
    expect(shape(trail("db_stories", ROWS.db_stories![0]!))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Палуверс", { kind: "page", projectId: "universe:u1" }],
      ["Холмы", null],
    ])
    expect(shape(trail("db_stories", ROWS.db_stories![1]!))?.[1]).toEqual([
      "Отдельные истории",
      { kind: "page", projectId: "standalone:w" },
    ])
  })

  it("has no trail for a row of the stories base that is no story's card", () => {
    expect(trail("db_stories", row("stray", "Чужая"))).toBeNull()
  })

  it("ends a universe's note at the universe", () => {
    expect(shape(trail("db_univ", ROWS.db_univ![0]!))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Палуверс", null],
    ])
  })

  it("puts a page of a world or plot section under its section, with no story", () => {
    const anna = row("anna", "Анна")
    expect(shape(trail("db_chars", anna))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Персонажи", { kind: "page", projectId: "w", sectionId: "chars" }],
      ["Анна", null],
    ])
    expect(trail("db_arcs", row("a", "Арка"))?.[1].label).toBe("Арки")
    // The author's own section is a world section too.
    expect(trail("db_mine", row("m", "Моя"))?.[1]).toMatchObject({
      label: "Моё",
      to: { sectionId: "mine" },
    })
  })

  it("puts a note under the notes section and its notebooks, each opening the notes tab", () => {
    const note = row("n1", "Черновик", {}, ["Идеи", "Сюжеты"])
    const tab = { kind: "page", projectId: "w", sectionId: "notes" }
    expect(shape(trail("db_notes", note))).toEqual([
      ["Мастерская", { kind: "page", projectId: "w" }],
      ["Заметки", tab],
      ["Идеи", tab],
      ["Сюжеты", tab],
      ["Черновик", null],
    ])
    expect(trail("db_notes", row("n2", "В корне"))?.map((s) => s.label)).toEqual([
      "Мастерская",
      "Заметки",
      "В корне",
    ])
  })

  it("has no trail for anything else", () => {
    expect(trail("db_elsewhere", row("x", "Обычная"))).toBeNull()
    // A section whose database is missing holds no page.
    expect(trail("db_gone", row("x", "Обычная"))).toBeNull()
    expect(
      noteTrail({
        catalog: null,
        databaseId: "db_hills",
        row: row("scene", "Сцена"),
        rows: ROWS,
        labels,
      }),
    ).toBeNull()
  })

  it("waits for the rows it needs instead of guessing the universe", () => {
    expect(trail("db_hills", ROWS.db_hills![0]!, { ...ROWS, db_stories: undefined })).toBeNull()
    expect(trail("db_hills", ROWS.db_hills![0]!, { ...ROWS, db_univ: undefined })).toBeNull()
    expect(trail("db_hills", ROWS.db_hills![0]!, { ...ROWS, db_hills: undefined })).toBeNull()
    expect(trail("db_stories", ROWS.db_stories![0]!, { ...ROWS, db_univ: undefined })).toBeNull()
  })

  it("has no trail for a page the text does not hold", () => {
    expect(trail("db_hills", row("orphan", "Нет в тексте"))).toBeNull()
  })

  it("names the databases to read for each place", () => {
    expect(trailDatabaseIds(cat, "db_hills")).toEqual(["db_hills", "db_stories", "db_univ"])
    expect(trailDatabaseIds(cat, "db_stories")).toEqual(["db_stories", "db_univ"])
    for (const id of ["db_univ", "db_chars", "db_notes", "db_elsewhere"]) {
      expect(trailDatabaseIds(cat, id)).toEqual([])
    }
  })
})
